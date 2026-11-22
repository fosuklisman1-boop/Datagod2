// Every 5 minutes (cron-job.org; lib/cron-migration/crons.json, fulfillment batch C): the strict MTN re-check.
// Releases strict holds a supplier has now approved, expires them after 72 h, and releases every hold when the
// strict switch is off. Overlap-safe: every release/expiry is a guarded held_registration claim. Logs counts only.
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { backgroundCron } from "@/lib/cron-background"
import { runStrictRecheck } from "@/lib/strict-verify/recheck"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Answer the scheduler at once (cron-job.org times out at 30 s); supplier checks run after the response.
export const GET = backgroundCron("mtn-strict-recheck", (request) => run(request))

async function run(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const summary = await runStrictRecheck(supabase, new Date())
  console.log("[CRON][STRICT-RECHECK] done", summary)
  return NextResponse.json({ ok: true, ...summary })
}
