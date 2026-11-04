import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { confirmHubtelPayment } from "@/lib/hubtel-pay/confirm"
import { listDueHubtelPayments, runHubtelPaymentsSweep } from "@/lib/hubtel-pay/sweep"

// Every 5 minutes (cron-job.org; lib/cron-migration/crons.json, fulfillment batch C): re-checks Hubtel payments
// whose callback never settled them: pending > 5 min, or confirming with a claim > 10 min old. Up to 50 per run,
// one at a time. confirmHubtelPayment owns every decision (status check + atomic claim), so overlapping runs or a
// callback arriving mid-sweep cannot double-fulfil. Logic: lib/hubtel-pay/sweep.ts.
export const dynamic = "force-dynamic"
// Well under the 10-minute confirming-claim window.
export const maxDuration = 120

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const result = await runHubtelPaymentsSweep({
      listDue: (now) => listDueHubtelPayments(sb, now),
      confirm: (reference) => confirmHubtelPayment(reference),
      now: () => new Date(),
    })
    console.log("[HUBTEL-PAYMENTS-SWEEP] run:", JSON.stringify(result))
    return NextResponse.json(result)
  } catch (err) {
    console.error("[HUBTEL-PAYMENTS-SWEEP] failed:", err instanceof Error ? err.message : "unknown error")
    return NextResponse.json({ error: "sweep failed" }, { status: 500 })
  }
}
