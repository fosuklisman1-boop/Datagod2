import type { SupabaseClient } from "@supabase/supabase-js"
import type { Board, DayRange } from "./periods"

export interface LeaderboardEntry {
  rank: number
  userId: string
  /** Public form only: first name + last initial ("Anthony A."). */
  name: string
  total: number
  orders: number
}

export interface Leaderboard {
  participants: number
  entries: LeaderboardEntry[]
}

export interface MyRank {
  participants: number
  /** Null when the user has no counted sales in the period. */
  rank: number | null
  total: number
  orders: number
  /** GH₵ more needed to pass the user directly above; null at #1 or unranked. */
  gapToNext: number | null
  /** GH₵ more needed to reach the podium; null when already in the top 3 or nobody is 3rd yet. */
  gapToTop3: number | null
}

export const DEFAULT_LIST_SIZE = 30

const MIN_GAP = 0.01

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(n) ? n : 0
}

function money(n: number): number {
  return Math.round(n * 100) / 100
}

/** "Anthony A." Names are shown as stored (casing kept); never an email or phone. */
export function maskName(firstName: unknown, lastName: unknown): string {
  const first = typeof firstName === "string" ? firstName.trim().split(/\s+/)[0] : ""
  const last = typeof lastName === "string" ? lastName.trim() : ""
  if (!first && !last) return "Seller"
  if (!first) return `${last[0].toUpperCase()}.`
  return last ? `${first} ${last[0].toUpperCase()}.` : first
}

/** Shapes get_leaderboard's JSON. Raw names never leave this function. */
export function shapeLeaderboard(raw: unknown): Leaderboard {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const rows = Array.isArray(obj.entries) ? obj.entries : []
  return {
    participants: num(obj.participants),
    entries: rows.map((r: Record<string, unknown>) => ({
      rank: num(r.rank),
      userId: String(r.user_id ?? ""),
      name: maskName(r.first_name, r.last_name),
      total: money(num(r.total)),
      orders: num(r.orders),
    })),
  }
}

/** Shapes get_leaderboard_rank's JSON into the "Check my rank" figures. */
export function shapeMyRank(raw: unknown): MyRank {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const rank = obj.rank === null || obj.rank === undefined ? null : num(obj.rank)
  const total = money(num(obj.total))
  const next = obj.next_total === null || obj.next_total === undefined ? null : num(obj.next_total)
  const third = obj.third_total === null || obj.third_total === undefined ? null : num(obj.third_total)
  const gap = (target: number) => money(Math.max(target - total, MIN_GAP))
  return {
    participants: num(obj.participants),
    rank,
    total,
    orders: num(obj.orders),
    gapToNext: rank !== null && rank > 1 && next !== null ? gap(next) : null,
    gapToTop3: (rank === null || rank > 3) && third !== null ? gap(third) : null,
  }
}

export async function getLeaderboard(db: SupabaseClient, board: Board, range: DayRange, limit = DEFAULT_LIST_SIZE): Promise<Leaderboard> {
  const { data, error } = await db.rpc("get_leaderboard", { p_board: board, p_from: range.start, p_to: range.end, p_limit: limit })
  if (error) throw new Error(`get_leaderboard failed: ${error.message}`)
  return shapeLeaderboard(data)
}

export async function getMyRank(db: SupabaseClient, userId: string, board: Board, range: DayRange): Promise<MyRank> {
  const { data, error } = await db.rpc("get_leaderboard_rank", { p_user_id: userId, p_board: board, p_from: range.start, p_to: range.end })
  if (error) throw new Error(`get_leaderboard_rank failed: ${error.message}`)
  return shapeMyRank(data)
}

export async function refreshLeaderboardTotals(db: SupabaseClient, range: DayRange): Promise<number> {
  const { data, error } = await db.rpc("refresh_leaderboard_totals", { p_from: range.start, p_to: range.end })
  if (error) throw new Error(`refresh_leaderboard_totals failed: ${error.message}`)
  return num(data)
}
