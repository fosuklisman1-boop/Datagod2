import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { dispatchCallback } from "@/lib/ussd-hubtel/callbacks"
import { sendFulfillmentCallback } from "@/lib/ussd-hubtel/relay"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  // A rate-limited admin comes back with isAdmin true AND a 429 errorResponse: honour it.
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const { sessionId } = (await request.json().catch(() => ({}))) as { sessionId?: string }
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 })

  try {
    const store = createSupabaseTxStore(createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!))
    const row = await store.findBySession(sessionId)
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (row.state !== "fulfilled" && row.state !== "needs_review") {
      return NextResponse.json({ error: "Nothing to call back for this transaction" }, { status: 409 })
    }
    // Re-arm: a manual retry gets a fresh window from now (Hubtel may still reject past 1h — surfaced in the error).
    if (row.callback_status === "failed") {
      await store.update(sessionId, { callback_status: "pending", paid_at: new Date().toISOString(), callback_last_error: null })
    }
    const result = await dispatchCallback(store, sendFulfillmentCallback, sessionId)
    return NextResponse.json({ result })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] retry-callback error:", safeDbError(e))
    return NextResponse.json({ error: "Failed to retry callback" }, { status: 500 })
  }
}
