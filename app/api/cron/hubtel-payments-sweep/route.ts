import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { backgroundCron } from "@/lib/cron-background"
import { verifyCronAuth } from "@/lib/cron-auth"
import { confirmHubtelPayment } from "@/lib/hubtel-pay/confirm"
import { listDueHubtelPayments, runHubtelPaymentsSweep, sendSweepAlert } from "@/lib/hubtel-pay/sweep"

// Every 5 minutes (cron-job.org; lib/cron-migration/crons.json, fulfillment batch C): re-checks Hubtel payments whose
// callback never settled them: pending > 5 min, confirming with a claim > 10 min old, or failed < 72h old and not
// checked for an hour (late payments). Up to 50 per run, least recently checked first, one at a time, no new row after
// 85s. confirmHubtelPayment owns every decision (status check + atomic claim), so overlapping runs or a callback
// arriving mid-sweep cannot double-fulfil. Logic: lib/hubtel-pay/sweep.ts.
//
// Runs in the background (lib/cron-background.ts): cron-job.org gives up after 30s and this can legitimately take 85s+.
// The caller only ever sees 202 or 401, so the result goes to the logs and failures reach admins via sendSweepAlert.
export const dynamic = "force-dynamic"
// The 85s budget, plus the last row's handler and the alert. Well under the 10-minute confirming-claim window.
export const maxDuration = 180

async function sweep(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const result = await runHubtelPaymentsSweep({
      listDue: (now) => listDueHubtelPayments(sb, now),
      confirm: (reference) => confirmHubtelPayment(reference),
      now: () => new Date(),
      alert: (message) => sendSweepAlert(sb, message),
    })
    console.log("[HUBTEL-PAYMENTS-SWEEP] run:", JSON.stringify(result))
    return NextResponse.json(result)
  } catch (err) {
    console.error("[HUBTEL-PAYMENTS-SWEEP] failed:", err instanceof Error ? err.message : "unknown error")
    return NextResponse.json({ error: "sweep failed" }, { status: 500 })
  }
}

export const GET = backgroundCron("hubtel-payments-sweep", sweep)
