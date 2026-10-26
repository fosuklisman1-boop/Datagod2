import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { monthChunks, parseAdminPeriod, periodLabel } from "@/lib/leaderboard/periods"
import { refreshLeaderboardTotals } from "@/lib/leaderboard/service"
import { closePeriod, ensurePeriod, findPeriod, leaderboardErrorJson } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * POST { kind, anchor, with_rewards } closes an ended period: freezes the top 30
 * per board (ranks 1-3 get their prize), notifies the podium and locks prizes.
 * A rewards close needs the period's six prizes; a no-reward close works on any
 * ended period, even one never configured.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const query = parseAdminPeriod(body?.kind, body?.anchor, new Date())
  if (!query) return NextResponse.json({ error: "Invalid period" }, { status: 400 })
  if (typeof body?.with_rewards !== "boolean") return NextResponse.json({ error: "with_rewards must be true or false" }, { status: 400 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const period = body.with_rewards
      ? await findPeriod(db, query.kind, query.range)
      : await ensurePeriod(db, query.kind, query.range)
    if (!period) return NextResponse.json({ error: "Set this period's prizes before closing with rewards" }, { status: 409 })
    if (period.status !== "open") return NextResponse.json({ error: "This period is already closed" }, { status: 409 })

    // Bring every day of the period up to date first, one month per call so a
    // yearly close never runs one huge statement. The close re-checks the last days.
    for (const chunk of monthChunks(query.range)) await refreshLeaderboardTotals(db, chunk)

    const label = periodLabel(query.kind, query.range)
    const result = await closePeriod(db, period.id, body.with_rewards, auth.userId, label)
    auditLog(db, {
      adminId: auth.userId,
      action: body.with_rewards ? "leaderboard_period_closed" : "leaderboard_period_closed_no_reward",
      newValue: { period_id: period.id, kind: query.kind, starts_on: query.range.start, ...result },
    })
    return NextResponse.json({ success: true, data: result })
  } catch (e) {
    return leaderboardErrorJson(e, "close")
  }
}
