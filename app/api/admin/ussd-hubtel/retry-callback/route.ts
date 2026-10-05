import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { dispatchCallback } from "@/lib/ussd-hubtel/callbacks"
import { sendFulfillmentCallback } from "@/lib/ussd-hubtel/relay"

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  const { sessionId } = (await request.json().catch(() => ({}))) as { sessionId?: string }
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 })

  const store = createSupabaseTxStore(createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!))
  const row = await store.findBySession(sessionId)
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (row.state === "awaiting_payment" || row.state === "failed") {
    return NextResponse.json({ error: "Nothing to call back for this transaction" }, { status: 409 })
  }
  // Re-arm: a manual retry gets a fresh window from now (Hubtel may still reject past 1h — surfaced in the error).
  if (row.callback_status === "failed") {
    await store.update(sessionId, { callback_status: "pending", paid_at: new Date().toISOString(), callback_last_error: null })
  }
  const result = await dispatchCallback(store, sendFulfillmentCallback, sessionId)
  return NextResponse.json({ result })
}
