import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { refundDb } from "@/lib/refunds/http"
import { defaultDeps, type StoredRefund } from "@/lib/refunds/service"
import { reconcileProcessingPaystackRefunds } from "@/lib/refunds/reconcile-paystack"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Fetch a wider window than we process: rows with a non-numeric ref are skipped and must not starve the rest.
const FETCH_LIMIT = 100

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const db = refundDb()
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString()
    const { data, error } = await db
      .from("order_refunds")
      .select("*")
      .eq("gateway", "paystack")
      .eq("status", "processing")
      .lt("updated_at", cutoff)
      .order("updated_at", { ascending: true })
      .limit(FETCH_LIMIT)
    if (error) {
      console.error("[REFUND-CRON] load failed:", error.message)
      return NextResponse.json({ error: "load failed" }, { status: 500 })
    }
    const result = await reconcileProcessingPaystackRefunds(defaultDeps(db), (data ?? []) as StoredRefund[])
    console.log("[REFUND-CRON]", JSON.stringify(result))
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error("[REFUND-CRON] error:", err)
    return NextResponse.json({ error: "reconcile failed" }, { status: 500 })
  }
}
