import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { parseAdminPeriod } from "@/lib/leaderboard/periods"
import { getLeaderboardConfig, periodView } from "@/lib/leaderboard/public"
import { findPeriod, leaderboardErrorJson, listPresets, listPrizePackages, listPrizes, liveStandings } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"

/**
 * Admin overview for one period: program switch, the period row (null until
 * something is saved for it), its prizes (cancelled ones included), live top 10
 * per board with contact details, presets and the bundles a prize can use.
 *   GET ?kind=daily|weekly|monthly|yearly&anchor=YYYY-MM-DD
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response

  const sp = request.nextUrl.searchParams
  const now = new Date()
  const query = parseAdminPeriod(sp.get("kind") ?? "monthly", sp.get("anchor"), now)
  if (!query) return NextResponse.json({ error: "Invalid period" }, { status: 400 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const [config, row, dashboard, shop, presets, packages] = await Promise.all([
      getLeaderboardConfig(db),
      findPeriod(db, query.kind, query.range),
      liveStandings(db, "dashboard", query.range),
      liveStandings(db, "shop", query.range),
      listPresets(db),
      listPrizePackages(db),
    ])
    const prizes = row ? await listPrizes(db, row.id) : []
    return NextResponse.json({
      success: true,
      data: {
        config,
        period: { ...periodView(query.kind, query.range, now), row },
        prizes,
        standings: { dashboard, shop },
        presets,
        packages,
      },
    })
  } catch (e) {
    return leaderboardErrorJson(e, "overview")
  }
}
