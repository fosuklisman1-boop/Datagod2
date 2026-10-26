import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { parseAdminPeriod } from "@/lib/leaderboard/periods"
import { isBoard, isPrizeRank, validatePrize } from "@/lib/leaderboard/prizes"
import { ensurePeriod, leaderboardErrorJson, packageName, setPrize } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"

/**
 * POST { kind, anchor, board, rank, prize } sets the prize for one rank of an
 * open period, replacing its current active prize. Creates the period row on
 * first use.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const query = parseAdminPeriod(body?.kind, body?.anchor, new Date())
  if (!query) return NextResponse.json({ error: "Invalid period" }, { status: 400 })
  if (!isBoard(body?.board) || !isPrizeRank(body?.rank)) return NextResponse.json({ error: "Invalid board or rank" }, { status: 400 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    let bundleName: string | null = null
    if (body?.prize?.prize_type === "data_bundle" && typeof body.prize.package_id === "string") {
      bundleName = await packageName(db, body.prize.package_id).catch(() => null)
      if (!bundleName) return NextResponse.json({ error: "That data bundle no longer exists" }, { status: 400 })
    }
    const prize = validatePrize(body?.prize, bundleName)
    if (!prize.ok) return NextResponse.json({ error: prize.error }, { status: 400 })

    const period = await ensurePeriod(db, query.kind, query.range)
    const row = await setPrize(db, period.id, body.board, body.rank, prize.value, auth.userId)
    auditLog(db, {
      adminId: auth.userId,
      action: "leaderboard_prize_set",
      newValue: { period_id: period.id, board: body.board, rank: body.rank, prize_id: row.id, ...prize.value },
    })
    return NextResponse.json({ success: true, data: { prize: row } })
  } catch (e) {
    return leaderboardErrorJson(e, "prize set")
  }
}
