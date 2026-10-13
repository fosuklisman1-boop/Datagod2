import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runScheduledDispatch } from "@/lib/sms/scheduled-service"

export const maxDuration = 300

/**
 * Promote due scheduled SMS sends and dispatch them. Every minute. Runs may overlap: promotion is
 * an atomic SKIP LOCKED gate, and anything not dispatched here stays 'queued' for the drain.
 */
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!
  try {
    const start = Date.now()
    // Stop starting new logs after ~100 s; cap each dispatch window to end well inside maxDuration.
    const summary = await runScheduledDispatch({ deadlineMs: start + 100_000, hardDeadlineMs: start + 280_000 })
    if ("errors" in summary && summary.errors > 0) {
      return NextResponse.json({ success: false, error: `${summary.errors} error(s) during scheduled dispatch`, data: summary }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: summary })
  } catch (e) {
    console.error("[CRON-SMS-SCHEDULED] Error:", e)
    return NextResponse.json({ success: false, error: (e as Error)?.message ?? "Internal error" }, { status: 500 })
  }
}
