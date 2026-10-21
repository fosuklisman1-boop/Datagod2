import { NextRequest, NextResponse } from "next/server"
import { refundDb } from "@/lib/refunds/http"
import { defaultDeps, type StoredRefund } from "@/lib/refunds/service"
import { handleHubtelRefundCallback } from "@/lib/refunds/hubtel-callback"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const refundId = request.nextUrl.searchParams.get("refund")
  const token = request.nextUrl.searchParams.get("t")
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    // Malformed JSON is handled by the handler (parked for review), not rejected.
  }
  try {
    const db = refundDb()
    const result = await handleHubtelRefundCallback(defaultDeps(db), {
      refundId, token, body,
      async loadRefund(id) {
        const { data, error } = await db.from("order_refunds").select("*").eq("id", id).maybeSingle()
        if (error) throw new Error(`refund load failed: ${error.message}`)
        return (data as StoredRefund | null) ?? null
      },
      async markConflict(id) {
        // Never throws: the conflict is also logged by the handler; a failed flag must not make Hubtel retry forever.
        try {
          const { error } = await db.from("order_refunds")
            .update({ error: "CONFLICT: Hubtel reported this refund paid after it was marked failed — check for a double refund" })
            .eq("id", id).eq("status", "failed")
          if (error) console.error("[HUBTEL-REFUND-CALLBACK] could not flag conflict for refund", id, error.message)
        } catch (e) {
          console.error("[HUBTEL-REFUND-CALLBACK] could not flag conflict for refund", id, e instanceof Error ? e.message : "unknown")
        }
      },
    })
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    // Log the refund id and error only (never the token or callback body). 500 makes Hubtel retry.
    console.error("[HUBTEL-REFUND-CALLBACK] error for refund", refundId, err instanceof Error ? err.message : "unknown")
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
