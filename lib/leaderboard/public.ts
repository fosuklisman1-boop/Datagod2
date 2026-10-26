import type { SupabaseClient } from "@supabase/supabase-js"
import {
  accraDay, hasEnded, periodLabel, shiftPeriod, timeLeftLabel,
  type Board, type DayRange, type PeriodKind,
} from "./periods"
import type { Leaderboard, MyRank } from "./service"
import type { ResultRow } from "./admin"

// ─── program switch (admin_settings) ───────────────────────────────────────
export const LEADERBOARD_CONFIG_KEY = "leaderboard_config"

export interface LeaderboardConfig {
  /** Paused: every user sees the maintenance notice instead of the rankings. */
  paused: boolean
}

export function resolveLeaderboardConfig(raw: unknown): LeaderboardConfig {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return { paused: r.paused === true }
}

export async function getLeaderboardConfig(db: SupabaseClient): Promise<LeaderboardConfig> {
  const { data, error } = await db.from("admin_settings").select("value").eq("key", LEADERBOARD_CONFIG_KEY).maybeSingle()
  if (error) throw error
  return resolveLeaderboardConfig(data?.value)
}

export const PAUSED_MESSAGE = "Top performers is under maintenance. Please check back soon."

// ─── page copy ─────────────────────────────────────────────────────────────
const KIND_WORD: Record<PeriodKind, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" }

export function headerTitle(kind: PeriodKind): string {
  return `${KIND_WORD[kind]} top performers`
}

export function countingRule(kind: PeriodKind): string {
  const span = {
    daily: "from midnight to midnight each day",
    weekly: "from Monday to Sunday each week",
    monthly: "from the 1st to the last day of each month",
    yearly: "from 1 January to 31 December each year",
  }[kind]
  return `Sales are counted ${span} (Ghana time). Only completed sales count.`
}

export const BOARD_COPY: Record<Board, { title: string; subtitle: string; rule: string }> = {
  dashboard: {
    title: "Top dashboard sales",
    subtitle: "Sales made from your dashboard.",
    rule: "Counts your completed purchases on the website and developer API, including data, airtime, AFA, results checker and bills.",
  },
  shop: {
    title: "Top shop sales",
    subtitle: "Sales made through your online shop.",
    rule: "Counts completed sales through your storefront and USSD.",
  },
}

export const NOT_COUNTED_NOTE = "Pending, processing, failed and refunded orders are not counted."

/** "GH₵ 156,764.61" */
export function formatCedis(amount: number): string {
  return `GH₵ ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ─── response shaping ──────────────────────────────────────────────────────
export interface PublicEntry {
  rank: number
  name: string
  total: number
  orders: number
  isMe: boolean
}

export interface PublicBoard {
  participants: number
  entries: PublicEntry[]
}

/** Drops user ids; the viewer's own row is flagged instead. */
export function toPublicBoard(board: Leaderboard, viewerId: string): PublicBoard {
  return {
    participants: board.participants,
    entries: board.entries.map(({ rank, name, total, orders, userId }) => ({ rank, name, total, orders, isMe: userId === viewerId })),
  }
}

/** Prize labels by board and rank, only when the period has prizes switched on. */
export type PublicRewards = Record<Board, Partial<Record<1 | 2 | 3, string>>>

export function publicRewards(
  period: { rewards_enabled: boolean } | null,
  prizes: { board: Board; rank: number; label: string; status: string }[],
): PublicRewards | null {
  if (!period?.rewards_enabled) return null
  const out: PublicRewards = { dashboard: {}, shop: {} }
  let any = false
  for (const p of prizes) {
    if (p.status !== "active" || (p.rank !== 1 && p.rank !== 2 && p.rank !== 3)) continue
    out[p.board][p.rank] = p.label
    any = true
  }
  return any ? out : null
}

/** A closed period's frozen boards, in the same shape as the live ones. */
export function boardsFromResults(results: ResultRow[]): Record<Board, Leaderboard> {
  const pick = (board: Board): Leaderboard => {
    const rows = results.filter((r) => r.board === board).sort((x, y) => x.rank - y.rank)
    return {
      participants: rows.length,
      entries: rows.map((r) => ({ rank: r.rank, userId: r.userId, name: r.displayName, total: r.total, orders: r.orders })),
    }
  }
  return { dashboard: pick("dashboard"), shop: pick("shop") }
}

/**
 * "Check my rank" for a closed period: the user's frozen rank, or null when
 * they finished outside the frozen top 30. No gaps: the period is over.
 */
export function myRankFromResults(results: ResultRow[], board: Board, userId: string): MyRank | null {
  const rows = results.filter((r) => r.board === board)
  const mine = rows.find((r) => r.userId === userId)
  if (!mine) return null
  return { participants: rows.length, rank: mine.rank, total: mine.total, orders: mine.orders, gapToNext: null, gapToTop3: null }
}

/** Prizes the winners of a closed period actually got (cancelled ones dropped). */
export function rewardsFromResults(results: ResultRow[]): PublicRewards | null {
  const out: PublicRewards = { dashboard: {}, shop: {} }
  let any = false
  for (const r of results) {
    if (!r.prize || r.prize.status !== "active" || (r.rank !== 1 && r.rank !== 2 && r.rank !== 3)) continue
    out[r.board][r.rank] = r.prize.label
    any = true
  }
  return any ? out : null
}

export function rewardLine(kind: PeriodKind): string {
  const every = { daily: "every day", weekly: "every week", monthly: "every month", yearly: "every year" }[kind]
  return `The top 3 sellers in each category win a reward ${every}.`
}

export interface PeriodView {
  kind: PeriodKind
  range: DayRange
  label: string
  /** Countdown chip; null once the period is over. */
  timeLeft: string | null
  ended: boolean
  /** Anchors for the previous / next period; next is null for the current period. */
  prevAnchor: string
  nextAnchor: string | null
}

export function periodView(kind: PeriodKind, range: DayRange, now: Date): PeriodView {
  const next = shiftPeriod(kind, range.start, 1)
  return {
    kind,
    range,
    label: periodLabel(kind, range),
    timeLeft: timeLeftLabel(kind, range, now),
    ended: hasEnded(range, now),
    prevAnchor: shiftPeriod(kind, range.start, -1),
    nextAnchor: next <= accraDay(now) ? next : null,
  }
}
