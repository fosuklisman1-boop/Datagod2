import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { refundDb } from "@/lib/refunds/http"
import { defaultDeps, type StoredRefund } from "@/lib/refunds/service"
import { reconcileProcessingPaystackRefunds, staleHubtelSendAlert } from "@/lib/refunds/reconcile-paystack"
import { sendThrottledAlert } from "@/lib/hubtel-pay/alert-throttle"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Per gateway: fetch a wider window than we process (MAX_PER_RUN) so skipped rows (e.g. non-numeric reversal refs) cannot starve the rest.
const FETCH_LIMIT = 100

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const db = refundDb()
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString()
    // One query per gateway so none can starve the others, and so null-ref reversals (unprocessable) never
    // occupy fetch slots. Payouts (Paystack, Moolre and Hubtel Send Money) are looked up by refund id, so any gateway_ref is fine for them.
    // Each processed row gets updated_at bumped, so oldest-first rotates through the queue across runs.
    const base = () => db.from("order_refunds").select("*").eq("status", "processing").lt("updated_at", cutoff)
      .order("updated_at", { ascending: true }).limit(FETCH_LIMIT)
    const [reversals, payouts, moolre, hubtelSend] = await Promise.all([
      base().eq("gateway", "paystack").not("gateway_ref", "is", null),
      base().eq("gateway", "paystack_payout"),
      base().eq("gateway", "moolre"),
      base().eq("gateway", "hubtel_send"),
    ])
    const error = reversals.error ?? payouts.error ?? moolre.error ?? hubtelSend.error
    if (error) {
      console.error("[REFUND-CRON] load failed:", error.message)
      return NextResponse.json({ error: "load failed" }, { status: 500 })
    }
    const rows = [...(reversals.data ?? []), ...(payouts.data ?? []), ...(moolre.data ?? []), ...(hubtelSend.data ?? [])] as StoredRefund[]
    rows.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    const result = await reconcileProcessingPaystackRefunds(defaultDeps(db), rows, Date.now(), {
      // A Hubtel payout still unconfirmed after 24 hours needs a human. Ids only: no number, no amount.
      onStaleHubtelSend: (stale) => sendThrottledAlert(
        db,
        staleHubtelSendAlert(stale),
        { key: "hubtel_send_stale_refund_alert", type: "hubtel_send_refund", description: "Last stale Hubtel payout refund alert", windowMs: 6 * 3_600_000, logPrefix: "[REFUND-CRON]" },
      ),
    })
    console.log("[REFUND-CRON]", JSON.stringify(result))
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error("[REFUND-CRON] error:", err)
    return NextResponse.json({ error: "reconcile failed" }, { status: 500 })
  }
}
