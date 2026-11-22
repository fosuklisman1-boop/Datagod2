import { SupabaseClient } from "@supabase/supabase-js"
import { processManualFulfillment } from "@/lib/fulfillment-service"
import { fulfillUssdOrder } from "@/lib/ussd/fulfill"
import { ORDER_TABLES } from "@/lib/order-queue/load-snapshots"
import type { OrderType } from "@/lib/order-queue/types"

// Orders processed per cron tick. Each order = one provider API call; keep
// this low enough that 20 × slowest-provider-latency stays under maxDuration.
const BATCH_SIZE = 20

// A row stuck in 'processing' for longer than this is considered orphaned
// (its worker died mid-run) and is reset to 'pending' for the next tick.
// COUPLED to `maxDuration` (300 s) in app/api/cron/drain-fulfillment-queue/route.ts:
// claim_fulfillment_queue stamps last_attempted_at once, at claim, and a tick can
// legitimately run until maxDuration. This MUST stay strictly greater than
// maxDuration plus a margin, or a later tick (every minute) resets rows the live
// tick is still going to send and the order is sent to a supplier twice.
// Raise this whenever maxDuration is raised.
export const STALE_MS = 6 * 60 * 1000

type DrainResult = {
  claimed: number
  completed: number
  failed: number
  reset_stale: number
}

/** Fails a queue row WITHOUT calling any supplier (the order was not in a sendable state). Logs ids only. */
async function skipRow(supabase: SupabaseClient, row: { id: string; order_id: string }, reason: string) {
  console.warn(`[FULFILLMENT-QUEUE] order ${row.order_id} skipped: ${reason}`)
  await supabase.from("fulfillment_queue").update({ status: "failed", error_message: reason }).eq("id", row.id)
}

export async function drainFulfillmentQueue(supabase: SupabaseClient): Promise<DrainResult> {
  // 1. Reset orphaned 'processing' rows back to 'pending'.
  const staleThreshold = new Date(Date.now() - STALE_MS).toISOString()
  const { data: resetRows } = await supabase
    .from("fulfillment_queue")
    .update({ status: "pending" })
    .eq("status", "processing")
    .lt("last_attempted_at", staleThreshold)
    .select("id")

  // 2. Atomically claim the next batch.
  const { data: rows, error: claimErr } = await supabase
    .rpc("claim_fulfillment_queue", { p_limit: BATCH_SIZE })

  if (claimErr) throw new Error(`claim_fulfillment_queue failed: ${claimErr.message}`)
  if (!rows || rows.length === 0) {
    return { claimed: 0, completed: 0, failed: 0, reset_stale: resetRows?.length ?? 0 }
  }

  let completed = 0
  let failed = 0

  for (const row of rows) {
    try {
      let success: boolean

      // Re-check the order itself before ANY supplier call. A row can wait minutes in the queue, and meanwhile
      // another path (per-row fulfil, a webhook, an admin status change) may have moved the order on. Every
      // legitimately queued order is still `pending` here; anything else is skipped, never sent twice.
      const source = ORDER_TABLES[row.order_type as OrderType]
      const isUssd = row.order_type === "ussd" || row.order_type === "ussd_shop"
      let order: any = null
      if (source) {
        const cols = isUssd ? `id, network, recipient_phone, package_size, ${source.statusCol}` : source.statusCol
        const { data, error } = await supabase.from(source.table).select(cols).eq("id", row.order_id).maybeSingle()
        if (error) {
          await skipRow(supabase, row, "order status unreadable")
          failed++
          continue
        }
        order = data
      }
      if (!source || !order) {
        await skipRow(supabase, row, "order status unreadable")
        failed++
        continue
      }
      const orderStatus = String(order[source.statusCol] ?? "").trim().toLowerCase()
      if (orderStatus !== "pending") {
        await skipRow(supabase, row, `order no longer pending (${orderStatus || "unknown"})`)
        failed++
        continue
      }

      if (isUssd) {
        const table = row.order_type === "ussd_shop" ? "ussd_shop_orders" : "ussd_orders"
        const ussdOrder = order
        const result = await fulfillUssdOrder(
          ussdOrder.id,
          ussdOrder.network,
          ussdOrder.recipient_phone,
          ussdOrder.package_size ?? "",
          true,
          table,
          row.provider ?? undefined  // the admin's chosen supplier (hard pin), same as the shop/bulk/api path
        )
        success = result.success
        if (!result.success) throw new Error(result.message || "USSD fulfillment failed")
      } else {
        const result = await processManualFulfillment(
          row.order_id,
          row.order_type as "shop" | "bulk" | "api",
          row.provider ?? undefined,
          true  // skipSms — bulk queue, no per-order SMS
        )
        success = result.success
        if (!result.success) throw new Error(result.message || "Fulfillment failed")
      }

      await supabase
        .from("fulfillment_queue")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", row.id)

      completed++
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[FULFILLMENT-QUEUE] order ${row.order_id} failed:`, msg)

      await supabase
        .from("fulfillment_queue")
        .update({ status: "failed", error_message: msg })
        .eq("id", row.id)

      failed++
    }
  }

  return { claimed: rows.length, completed, failed, reset_stale: resetRows?.length ?? 0 }
}
