import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { refundDb } from "@/lib/refunds/http"
import { defaultDeps, type StoredRefund } from "@/lib/refunds/service"
import { reconcileProcessingPaystackRefunds } from "@/lib/refunds/reconcile-paystack"

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
    // Two queries so neither gateway can starve the other, and so null-ref reversals (unprocessable) never
    // occupy fetch slots. Payouts are looked up by refund id, so a null/TRF_ gateway_ref is fine for them.
    // Each processed row gets updated_at bumped, so oldest-first rotates through the queue across runs.
    const base = () => db.from("order_refunds").select("*").eq("status", "processing").lt("updated_at", cutoff)
      .order("updated_at", { ascending: true }).limit(FETCH_LIMIT)
    const [reversals, payouts] = await Promise.all([
      base().eq("gateway", "paystack").not("gateway_ref", "is", null),
      base().eq("gateway", "paystack_payout"),
    ])
    const error = reversals.error ?? payouts.error
    if (error) {
      console.error("[REFUND-CRON] load failed:", error.message)
      return NextResponse.json({ error: "load failed" }, { status: 500 })
    }
    const rows = [...(reversals.data ?? []), ...(payouts.data ?? [])] as StoredRefund[]
    rows.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    const result = await reconcileProcessingPaystackRefunds(defaultDeps(db), rows)
    console.log("[REFUND-CRON]", JSON.stringify(result))
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error("[REFUND-CRON] error:", err)
    return NextResponse.json({ error: "reconcile failed" }, { status: 500 })
  }
}
