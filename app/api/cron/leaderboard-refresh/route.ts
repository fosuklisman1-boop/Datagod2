import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { refreshWindow } from "@/lib/leaderboard/periods"
import { refreshLeaderboardTotals } from "@/lib/leaderboard/service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Every 5 minutes: rebuilds leaderboard_daily_totals for yesterday and today
// (late completions and refunds), and the last 8 days just after midnight.
export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  const range = refreshWindow(new Date())
  try {
    const rows = await refreshLeaderboardTotals(supabase, range)
    return NextResponse.json({ success: true, from: range.start, to: range.end, rows })
  } catch (error) {
    console.error("[LEADERBOARD-REFRESH] failed:", error)
    return NextResponse.json({ success: false, error: "Leaderboard refresh failed" }, { status: 500 })
  }
}
