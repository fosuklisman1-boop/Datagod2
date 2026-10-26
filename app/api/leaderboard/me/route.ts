import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { BOARDS, parsePeriodQuery, type Board } from "@/lib/leaderboard/periods"
import { getMyRank } from "@/lib/leaderboard/service"
import { getLeaderboardConfig, myRankFromResults, notRankedReason, NOT_RANKED_MESSAGE, PAUSED_MESSAGE } from "@/lib/leaderboard/public"
import { findPeriod, listResults } from "@/lib/leaderboard/admin"

/**
 * "Check my rank" for the signed-in user on one board.
 *   GET ?board=dashboard|shop&kind=...&anchor=... -> { success, data: { paused: false, rank: MyRank } }
 * Identity comes only from the Bearer token, so a user can only ever see their own rank.
 * A closed period answers from its frozen results; outside them, the live rank without gaps.
 */

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }
  const db = serviceClient()
  const { data: { user }, error: authError } = await db.auth.getUser(authHeader.slice(7))
  if (authError || !user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const rate = await applyRateLimit(request, "leaderboard_me", 30, 60 * 1000, user.id)
  if (!rate.allowed) {
    return NextResponse.json({ success: false, error: "Too many requests" }, { status: 429 })
  }

  const params = request.nextUrl.searchParams
  const board = params.get("board")
  const query = parsePeriodQuery(params.get("kind") ?? "monthly", params.get("anchor"), new Date())
  if (!query || !board || !(BOARDS as readonly string[]).includes(board)) {
    return NextResponse.json({ success: false, error: "Invalid board or period" }, { status: 400 })
  }

  try {
    const config = await getLeaderboardConfig(db)
    if (config.paused) {
      return NextResponse.json({ success: true, data: { paused: true, message: PAUSED_MESSAGE } })
    }
    // Admins and excluded accounts are never ranked: say so instead of "no sales".
    const notRanked = await notRankedReason(db, user.id)
    if (notRanked) {
      return NextResponse.json({ success: true, data: { paused: false, final: false, notRanked, message: NOT_RANKED_MESSAGE[notRanked] } })
    }
    const row = await findPeriod(db, query.kind, query.range).catch(() => null)
    if (row && row.status !== "open") {
      const results = await listResults(db, row.id).catch(() => null)
      if (results) {
        const frozen = myRankFromResults(results, board as Board, user.id)
        const rank = frozen ?? { ...(await getMyRank(db, user.id, board as Board, query.range)), gapToNext: null, gapToTop3: null }
        return NextResponse.json({ success: true, data: { paused: false, final: true, rank } })
      }
    }
    const rank = await getMyRank(db, user.id, board as Board, query.range)
    return NextResponse.json({ success: true, data: { paused: false, final: false, rank } })
  } catch (error) {
    console.error("[/api/leaderboard/me] failed:", error)
    return NextResponse.json({ success: false, error: "Could not load your rank" }, { status: 500 })
  }
}
