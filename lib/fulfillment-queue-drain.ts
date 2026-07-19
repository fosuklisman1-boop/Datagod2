import { SupabaseClient } from "@supabase/supabase-js"
import { processManualFulfillment } from "@/lib/fulfillment-service"
import { fulfillUssdOrder } from "@/lib/ussd/fulfill"

// Orders processed per cron tick. Each order = one provider API call; keep
// this low enough that 20 × slowest-provider-latency stays under maxDuration.
const BATCH_SIZE = 20

// A row stuck in 'processing' for longer than this is considered orphaned
// (its worker died mid-run) and is reset to 'pending' for the next tick.
const STALE_MS = 4 * 60 * 1000

type DrainResult = {
  claimed: number
  completed: number
  failed: number
  reset_stale: number
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

      if (row.order_type === "ussd" || row.order_type === "ussd_shop") {
        const table = row.order_type === "ussd_shop" ? "ussd_shop_orders" : "ussd_orders"
        const { data: ussdOrder, error: fetchErr } = await supabase
          .from(table)
          .select("id, network, recipient_phone, package_size")
          .eq("id", row.order_id)
          .single()

        if (fetchErr || !ussdOrder) {
          throw new Error("USSD order not found")
        }
        const result = await fulfillUssdOrder(
          ussdOrder.id,
          ussdOrder.network,
          ussdOrder.recipient_phone,
          ussdOrder.package_size ?? "",
          true,
          table
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
