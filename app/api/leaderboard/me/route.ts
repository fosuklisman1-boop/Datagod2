import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { BOARDS, parsePeriodQuery, type Board } from "@/lib/leaderboard/periods"
import { getMyRank } from "@/lib/leaderboard/service"
import { getLeaderboardConfig, PAUSED_MESSAGE } from "@/lib/leaderboard/public"

/**
 * "Check my rank" for the signed-in user on one board.
 *   GET ?board=dashboard|shop&kind=...&anchor=... -> { success, data: { paused: false, rank: MyRank } }
 * Identity comes only from the Bearer token, so a user can only ever see their own rank.
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
    const rank = await getMyRank(db, user.id, board as Board, query.range)
    return NextResponse.json({ success: true, data: { paused: false, rank } })
  } catch (error) {
    console.error("[/api/leaderboard/me] failed:", error)
    return NextResponse.json({ success: false, error: "Could not load your rank" }, { status: 500 })
  }
}
