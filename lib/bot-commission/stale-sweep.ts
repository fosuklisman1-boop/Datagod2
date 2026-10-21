// Stale-unpaid sweep for commission-cashback bot orders from the Uzo main + shop USSD (bot_surface 'ussd' /
// 'ussd_shop') and the WhatsApp main + shop bots ('whatsapp' / 'whatsapp_shop'). Those orders are created unpaid and
// charged by a MoMo prompt; a buyer who never approves (or never finishes the SMS / Paystack OTP) leaves them pending +
// unpaid, where they would count against the engine's pending caps forever. 30 min is past every WhatsApp window (SMS
// code and OTP pointer 10 min, replay 15 min); a buyer still at *_PAY_VERIFY after the sweep finds the order not open
// and is never charged. Hubtel USSD bot orders have their own expiry (status check); storefront and other channels are
// not touched.
//
// Each run: the oldest stale rows (pending + unpaid, older than 30 min) per table, at most `batch`, are failed with the
// bot commission guarded patch (status 'failed', failure_reason 'payment not completed'; payment_status stays
// 'unpaid', so the row is never refundable or dispatched). Every update re-checks the same guards, so an order paid in
// the meantime is never touched. Then their still-pending wallet_payments rows (order_type cs_bill / cs_bundle) are
// marked failed.
//
// Late payment: a Paystack charge.success that arrives after the sweep still reaches confirmCommissionOrder
// (settleStorefrontWebhook). The order flips unpaid -> paid but, being 'failed', is never dispatched and no shop share is
// credited; admins get an URGENT "refund it" alert (the needs-review path). See the runbook.
import type { SupabaseClient } from "@supabase/supabase-js"
import { ORDER_TABLES } from "@/lib/ussd-hubtel/order-tables"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"

export const STALE_BOT_ORDER_MINUTES = 30
/** Max orders failed per table per run (the cron runs every 10 minutes). */
export const STALE_BOT_SWEEP_BATCH = 200
/** Max ids in one `.in()` filter. */
export const STALE_BOT_SWEEP_CHUNK = 100
/** Uzo main + shop USSD and the WhatsApp main + shop bots. `hubtel_ussd` is never swept (it has its own expiry). */
export const BOT_SWEPT_SURFACES = ["ussd", "ussd_shop", "whatsapp", "whatsapp_shop"] as const

const SWEPT = [
  { table: "hubtel_bill_orders", orderType: "cs_bill" },
  { table: "hubtel_data_orders", orderType: "cs_bundle" },
] as const
type SweptTable = (typeof SWEPT)[number]["table"]

export interface StaleSweepCounts { found: number; failed: number; payments: number }
export interface StaleSweepResult { cutoff: string; tables: Record<SweptTable, StaleSweepCounts>; errors: number }

const TAG = "[BOT-STALE-SWEEP]"

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** Never throws: DB errors are logged and counted, and the run goes on with the next chunk / table. */
export async function expireStaleBotOrders(
  db: SupabaseClient, opts: { now?: number; minutes?: number; batch?: number } = {},
): Promise<StaleSweepResult> {
  const now = opts.now ?? Date.now()
  const cutoff = new Date(now - (opts.minutes ?? STALE_BOT_ORDER_MINUTES) * 60_000).toISOString()
  const batch = opts.batch ?? STALE_BOT_SWEEP_BATCH
  const result: StaleSweepResult = {
    cutoff,
    tables: { hubtel_bill_orders: { found: 0, failed: 0, payments: 0 }, hubtel_data_orders: { found: 0, failed: 0, payments: 0 } },
    errors: 0,
  }

  for (const { table, orderType } of SWEPT) {
    const counts = result.tables[table]
    // The same guards on the select and on every update (the update is what protects a row paid in between).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guarded = (q: any) =>
      q.eq("channel", "bots").in("bot_surface", [...BOT_SWEPT_SURFACES]).eq("status", "pending").eq("payment_status", "unpaid")
        .lt("created_at", cutoff)

    let ids: string[]
    try {
      const { data, error } = await guarded(db.from(table).select("id")).order("created_at", { ascending: true }).limit(batch)
      if (error) throw error
      ids = ((data ?? []) as { id: string }[]).map(r => r.id)
    } catch (e) {
      console.error(TAG, `${table} select failed:`, safeDbError(e))
      result.errors++
      continue
    }
    counts.found = ids.length

    for (const part of chunks(ids, STALE_BOT_SWEEP_CHUNK)) {
      let failed: string[]
      try {
        const { data, error } = await guarded(db.from(table).update(ORDER_TABLES[table].failPatch()).in("id", part)).select("id")
        if (error) throw error
        failed = ((data ?? []) as { id: string }[]).map(r => r.id)
      } catch (e) {
        console.error(TAG, `${table} fail update failed:`, safeDbError(e))
        result.errors++
        continue
      }
      counts.failed += failed.length
      if (failed.length === 0) continue
      try {
        const { data, error } = await db
          .from("wallet_payments")
          .update({ status: "failed", updated_at: new Date(now).toISOString() })
          .eq("order_type", orderType)
          .in("order_id", failed)
          .eq("status", "pending")
          .select("id")
        if (error) throw error
        counts.payments += (data ?? []).length
      } catch (e) {
        console.error(TAG, `wallet_payments (${orderType}) update failed:`, safeDbError(e))
        result.errors++
      }
    }
  }
  return result
}
