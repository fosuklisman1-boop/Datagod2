// app/api/cron/text-to-buy-notify/route.ts
//
// Text-to-Buy follow-ups every minute: payment/delivery notices for linked orders, recovery of texts a crash stranded,
// retention purge and the quiet-phone alert. All logic: lib/text-to-buy/notify.ts. Overlap-safe (every notice is recorded
// with a guarded update before it is sent). Logs counts only: no phone numbers, texts or amounts.
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { loadTtbSettings } from "@/lib/text-to-buy/settings"
import { runTtbNotify } from "@/lib/text-to-buy/notify"

export const maxDuration = 60

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const settings = await loadTtbSettings(supabase)
    const result = await runTtbNotify(supabase, new Date(), settings)
    const active = result.unpaid + result.repriced + result.delivered + result.delayed + result.closed + result.recovered + result.purged
    if (active > 0 || result.quietAlert) {
      console.log(
        `[CRON-TTB-NOTIFY] checked=${result.checked} unpaid=${result.unpaid} repriced=${result.repriced} delivered=${result.delivered} delayed=${result.delayed} closed=${result.closed} recovered=${result.recovered} purged=${result.purged} quietAlert=${result.quietAlert}`,
      )
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error("[CRON-TTB-NOTIFY] Unexpected error:", err instanceof Error ? err.name : "unknown")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
