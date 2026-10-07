import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { dispatchCallback } from "@/lib/ussd-hubtel/callbacks"
import { sendFulfillmentCallback } from "@/lib/ussd-hubtel/relay"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"
import { purgeOldCallbackLogs, withOutboundLogging } from "@/lib/ussd-hubtel/callback-log"

export const maxDuration = 300

/** Stop taking new rows well before maxDuration; the next run (every minute) picks up the rest. */
const TIME_BUDGET_MS = 240_000

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  const start = Date.now()
  const store = createSupabaseTxStore(supabase)
  const rows = await store.listPendingCallbacks(50)
  // Every attempt is written to hubtel_callback_logs (best-effort; never changes the result).
  const send = withOutboundLogging(sendFulfillmentCallback, supabase)
  const counts: Record<string, number> = {}
  let processed = 0
  for (const row of rows) {
    if (Date.now() - start > TIME_BUDGET_MS) {
      console.warn("[HUBTEL-CRON] callbacks time budget reached; deferring", rows.length - processed, "rows")
      break
    }
    processed++
    try {
      const r = await dispatchCallback(store, send, row.session_id)
      counts[r] = (counts[r] ?? 0) + 1
    } catch (e) { console.error("[HUBTEL-CRON] callback error:", row.session_id, safeDbError(e)) }
    // This row's log write, awaited only AFTER dispatchCallback marked it (bounded ~3s, never throws).
    await send.flush()
  }
  // 30-day retention for the callback log; best-effort (swallows its own errors).
  await purgeOldCallbackLogs(supabase)
  return NextResponse.json({ listed: rows.length, processed, ...counts })
}
