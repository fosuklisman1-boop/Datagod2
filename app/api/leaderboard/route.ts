import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { parsePeriodQuery, type DayRange, type PeriodKind } from "@/lib/leaderboard/periods"
import { getLeaderboard, type Leaderboard } from "@/lib/leaderboard/service"
import {
  boardsFromResults, getLeaderboardConfig, periodView, publicRewards, rewardsFromResults, toPublicBoard, PAUSED_MESSAGE, type PublicRewards,
} from "@/lib/leaderboard/public"
import { findPeriod, listPrizes, listResults } from "@/lib/leaderboard/admin"

/**
 * Top performers for one period, both boards.
 *   GET ?kind=daily|weekly|monthly|yearly&anchor=YYYY-MM-DD (anchor optional = current period)
 *   -> { success, data: { paused: false, period, boards: { dashboard, shop }, rewards } }
 *      rewards: prize labels by board/rank, or null when the period has no prizes on
 *      final: true when the period is closed and the boards are its frozen results
 *   -> { success, data: { paused: true, message } } while the admin has paused the program
 * Signed-in users only; identity comes from the Bearer token. Names are masked and
 * user ids never leave the server (the viewer's own row is flagged isMe).
 */

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// Per-instance cache of ranked boards. Totals refresh every 5 minutes anyway.
const LIVE_TTL_MS = 60 * 1000
const ENDED_TTL_MS = 10 * 60 * 1000
const MAX_CACHED = 60
interface CachedBoards {
  expires: number
  boards: { dashboard: Leaderboard; shop: Leaderboard }
  rewards: PublicRewards | null
  /** True once the admin has closed the period: these are the frozen final results. */
  final: boolean
}
const cache = new Map<string, CachedBoards>()

const soft = <T,>(what: string, fallback: T) => (e: { message?: string } | null) => {
  console.warn(`[/api/leaderboard] ${what} failed:`, e?.message ?? e)
  return fallback
}

async function loadBoards(db: ReturnType<typeof serviceClient>, kind: PeriodKind, range: DayRange, ended: boolean): Promise<CachedBoards> {
  const key = `${kind}:${range.start}:${range.end}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit

  // Prize and result tables are optional here: if they can't be read (e.g. a
  // migration isn't applied yet) the live rankings still load, without rewards.
  const row = await findPeriod(db, kind, range).catch(soft("period lookup", null))
  let entry: CachedBoards | null = null

  if (row && row.status !== "open") {
    const results = await listResults(db, row.id).catch(soft("results lookup", null))
    if (results) {
      entry = { expires: Date.now() + ENDED_TTL_MS, boards: boardsFromResults(results), rewards: rewardsFromResults(results), final: true }
    }
  }
  if (!entry) {
    const [dashboard, shop] = await Promise.all([getLeaderboard(db, "dashboard", range), getLeaderboard(db, "shop", range)])
    const rewards = row?.rewards_enabled ? publicRewards(row, await listPrizes(db, row.id).catch(soft("prizes lookup", []))) : null
    entry = { expires: Date.now() + (ended ? ENDED_TTL_MS : LIVE_TTL_MS), boards: { dashboard, shop }, rewards, final: false }
  }

  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string)
  cache.set(key, entry)
  return entry
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

  const rate = await applyRateLimit(request, "leaderboard_view", 60, 60 * 1000, user.id)
  if (!rate.allowed) {
    return NextResponse.json({ success: false, error: "Too many requests" }, { status: 429 })
  }

  const params = request.nextUrl.searchParams
  const now = new Date()
  const query = parsePeriodQuery(params.get("kind") ?? "monthly", params.get("anchor"), now)
  if (!query) {
    return NextResponse.json({ success: false, error: "Invalid period" }, { status: 400 })
  }

  try {
    const config = await getLeaderboardConfig(db)
    if (config.paused) {
      return NextResponse.json({ success: true, data: { paused: true, message: PAUSED_MESSAGE } })
    }

    const period = periodView(query.kind, query.range, now)
    const { boards, rewards, final } = await loadBoards(db, query.kind, query.range, period.ended)
    return NextResponse.json({
      success: true,
      data: {
        paused: false,
        period,
        boards: { dashboard: toPublicBoard(boards.dashboard, user.id), shop: toPublicBoard(boards.shop, user.id) },
        rewards,
        final,
      },
    })
  } catch (error) {
    console.error("[/api/leaderboard] failed:", error)
    return NextResponse.json({ success: false, error: "Could not load the leaderboard" }, { status: 500 })
  }
}
