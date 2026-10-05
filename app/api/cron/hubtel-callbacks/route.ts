import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { dispatchCallback } from "@/lib/ussd-hubtel/callbacks"
import { sendFulfillmentCallback } from "@/lib/ussd-hubtel/relay"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  const store = createSupabaseTxStore(supabase)
  const rows = await store.listPendingCallbacks(50)
  const counts: Record<string, number> = {}
  for (const row of rows) {
    try {
      const r = await dispatchCallback(store, sendFulfillmentCallback, row.session_id)
      counts[r] = (counts[r] ?? 0) + 1
    } catch (e) { console.error("[HUBTEL-CRON] callback error:", row.session_id, e) }
  }
  return NextResponse.json({ processed: rows.length, ...counts })
}
