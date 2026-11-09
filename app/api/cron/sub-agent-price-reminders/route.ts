import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { backgroundCron } from "@/lib/cron-background"
import { runPriceReminders, defaultPriceReminderDeps } from "@/lib/sub-agents/price-reminders"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Every 5 minutes (cron-job.org; lib/cron-migration/crons.json): "set your prices and go live" SMS + email to
// storefront joiners at 10 min, 48 h and 72 h after joining. Overlap-safe: each stage is claimed atomically before
// sending. Answers the scheduler at once; up to 100 joiners are handled after the response. Logic:
// lib/sub-agents/price-reminders.ts.
export const GET = backgroundCron("sub-agent-price-reminders", (request) => run(request))

async function run(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const result = await runPriceReminders(supabase, new Date(), defaultPriceReminderDeps())
    console.log("[PRICE-REMINDERS] run:", JSON.stringify(result))
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error("[PRICE-REMINDERS] failed:", error instanceof Error ? error.message : "unknown error")
    return NextResponse.json({ ok: false, error: "Price reminders failed" }, { status: 500 })
  }
}
