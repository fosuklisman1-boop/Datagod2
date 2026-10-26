import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Board, DayRange, PeriodKind } from "./periods"
import { bundleLabel, type PrizeFields, type PrizeRow } from "./prizes"
import { LEADERBOARD_CONFIG_KEY, getLeaderboardConfig } from "./public"

export interface PeriodRow {
  id: string
  kind: PeriodKind | "custom"
  starts_on: string
  ends_on: string
  rewards_enabled: boolean
  status: "open" | "closed" | "closed_no_reward"
  closed_at: string | null
}

export interface StandingRow {
  rank: number
  userId: string
  name: string
  email: string | null
  phone: string | null
  total: number
  orders: number
}

export interface PresetRow extends PrizeFields {
  id: string
  name: string
  created_at: string
}

const PERIOD_COLS = "id, kind, starts_on, ends_on, rewards_enabled, status, closed_at"
const PRIZE_COLS = "id, period_id, board, rank, prize_type, label, amount, package_id, network, role, duration_days, status, cancelled_at, created_at"
const PRESET_COLS = "id, name, prize_type, label, amount, package_id, network, role, duration_days, created_at"

/** Existing row for a standard period, or null (rows are only created on first write). */
export async function findPeriod(db: SupabaseClient, kind: PeriodKind, range: DayRange): Promise<PeriodRow | null> {
  const { data, error } = await db.from("leaderboard_periods").select(PERIOD_COLS).eq("kind", kind).eq("starts_on", range.start).maybeSingle()
  if (error) throw error
  return (data as PeriodRow | null) ?? null
}

export async function ensurePeriod(db: SupabaseClient, kind: PeriodKind, range: DayRange): Promise<PeriodRow> {
  const { data, error } = await db.rpc("leaderboard_period_ensure", { p_kind: kind, p_start: range.start, p_end: range.end })
  if (error) throw error
  return data as PeriodRow
}

export async function listPrizes(db: SupabaseClient, periodId: string): Promise<PrizeRow[]> {
  const { data, error } = await db.from("leaderboard_prizes").select(PRIZE_COLS).eq("period_id", periodId)
    .order("board").order("rank").order("created_at")
  if (error) throw error
  return (data ?? []) as PrizeRow[]
}

export async function setPrize(db: SupabaseClient, periodId: string, board: Board, rank: number, prize: PrizeFields, adminId: string): Promise<PrizeRow> {
  const { data, error } = await db.rpc("leaderboard_prize_set", { p_period_id: periodId, p_board: board, p_rank: rank, p_prize: prize, p_admin: adminId })
  if (error) throw error
  return data as PrizeRow
}

export async function cancelPrize(db: SupabaseClient, prizeId: string, adminId: string): Promise<PrizeRow> {
  const { data, error } = await db.rpc("leaderboard_prize_cancel", { p_prize_id: prizeId, p_admin: adminId })
  if (error) throw error
  return data as PrizeRow
}

export async function listPresets(db: SupabaseClient): Promise<PresetRow[]> {
  const { data, error } = await db.from("leaderboard_prize_presets").select(PRESET_COLS).order("name")
  if (error) throw error
  return (data ?? []) as PresetRow[]
}

export async function setPaused(db: SupabaseClient, paused: boolean, adminId: string): Promise<{ paused: boolean }> {
  const before = await getLeaderboardConfig(db)
  const { error } = await db.from("admin_settings").upsert(
    {
      key: LEADERBOARD_CONFIG_KEY,
      value: { ...before, paused },
      description: "Top performers program switch. paused=true shows users a maintenance notice instead of the rankings.",
      updated_at: new Date().toISOString(),
      updated_by: adminId,
    },
    { onConflict: "key" },
  )
  if (error) throw error
  return { paused }
}

/** Available bundles for the data-bundle prize picker, labelled "MTN 10GB". */
export async function listPrizePackages(db: SupabaseClient): Promise<{ id: string; network: string; size: string; label: string }[]> {
  const { data, error } = await db.from("packages").select("id, network, size").eq("is_available", true).order("network").order("price")
  if (error) throw error
  return ((data ?? []) as { id: string; network: string; size: string }[]).map((p) => ({ ...p, label: bundleLabel(p.network, p.size) }))
}

/** "MTN 10GB" for a package id, or null if it no longer exists. */
export async function packageName(db: SupabaseClient, id: string): Promise<string | null> {
  const { data, error } = await db.from("packages").select("size, network").eq("id", id).maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as { size: string | null; network: string | null }
  return bundleLabel(row.network, row.size)
}

/** Live top N with full name and contact details. Admin only: never send this to users. */
export async function liveStandings(db: SupabaseClient, board: Board, range: DayRange, limit = 10): Promise<StandingRow[]> {
  const { data, error } = await db.rpc("get_leaderboard", { p_board: board, p_from: range.start, p_to: range.end, p_limit: limit })
  if (error) throw error
  const entries = (((data as { entries?: unknown[] } | null)?.entries ?? []) as Record<string, unknown>[])
  const ids = entries.map((e) => String(e.user_id))
  const contacts = new Map<string, { email: string | null; phone_number: string | null }>()
  if (ids.length) {
    const { data: users, error: usersError } = await db.from("users").select("id, email, phone_number").in("id", ids)
    if (usersError) throw usersError
    for (const u of (users ?? []) as { id: string; email: string | null; phone_number: string | null }[]) contacts.set(u.id, u)
  }
  return entries.map((e) => {
    const id = String(e.user_id)
    const name = [e.first_name, e.last_name].filter((s) => typeof s === "string" && s.trim()).join(" ") || "Unnamed user"
    return {
      rank: Number(e.rank),
      userId: id,
      name,
      email: contacts.get(id)?.email ?? null,
      phone: contacts.get(id)?.phone_number ?? null,
      total: Number(e.total),
      orders: Number(e.orders),
    }
  })
}

export interface ResultRow {
  id: string
  board: Board
  rank: number
  userId: string
  /** Masked public name, frozen at close. */
  displayName: string
  total: number
  orders: number
  prize: { id: string; label: string; prize_type: string; status: "active" | "cancelled" } | null
}

export interface AdminResultRow extends ResultRow {
  fullName: string
  email: string | null
  phone: string | null
}

/** Frozen results of a closed period, best rank first, with each rank's prize. */
export async function listResults(db: SupabaseClient, periodId: string): Promise<ResultRow[]> {
  const { data, error } = await db.from("leaderboard_results")
    .select("id, board, rank, user_id, display_name, total_amount, order_count, prize:leaderboard_prizes(id, label, prize_type, status)")
    .eq("period_id", periodId).order("board").order("rank")
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const prize = (Array.isArray(r.prize) ? r.prize[0] : r.prize) as ResultRow["prize"] | undefined
    return {
      id: String(r.id),
      board: r.board as Board,
      rank: Number(r.rank),
      userId: String(r.user_id),
      displayName: String(r.display_name),
      total: Number(r.total_amount),
      orders: Number(r.order_count),
      prize: prize ?? null,
    }
  })
}

/** Results plus full name and contact details. Admin only. */
export async function listAdminResults(db: SupabaseClient, periodId: string): Promise<AdminResultRow[]> {
  const rows = await listResults(db, periodId)
  const ids = [...new Set(rows.map((r) => r.userId))]
  const users = new Map<string, { email: string | null; phone_number: string | null; first_name: string | null; last_name: string | null }>()
  if (ids.length) {
    const { data, error } = await db.from("users").select("id, email, phone_number, first_name, last_name").in("id", ids)
    if (error) throw error
    for (const u of (data ?? []) as { id: string; email: string | null; phone_number: string | null; first_name: string | null; last_name: string | null }[]) users.set(u.id, u)
  }
  return rows.map((r) => {
    const u = users.get(r.userId)
    return {
      ...r,
      fullName: [u?.first_name, u?.last_name].filter((s) => s && s.trim()).join(" ") || r.displayName,
      email: u?.email ?? null,
      phone: u?.phone_number ?? null,
    }
  })
}

export async function closePeriod(
  db: SupabaseClient, periodId: string, withRewards: boolean, adminId: string, periodLabel: string,
): Promise<{ status: string; results: number; notified: number }> {
  const { data, error } = await db.rpc("leaderboard_close_period", {
    p_period_id: periodId, p_with_rewards: withRewards, p_admin: adminId, p_period_label: periodLabel,
  })
  if (error) throw error
  return data as { status: string; results: number; notified: number }
}

const RPC_ERRORS: Record<string, { status: number; error: string }> = {
  period_closed: { status: 409, error: "This period is closed. Its prizes can no longer change." },
  period_not_found: { status: 404, error: "Period not found" },
  prize_not_found: { status: 404, error: "Prize not found" },
  prize_already_cancelled: { status: 409, error: "That prize is already cancelled" },
  period_not_ended: { status: 409, error: "This period has not ended yet" },
  rewards_off: { status: 409, error: "Prizes are off for this period. Switch them on or close with no reward." },
  prizes_missing: { status: 409, error: "All six prizes must be set before closing with rewards" },
}

/** Maps a database error from the leaderboard RPCs/tables to a JSON response. */
export function leaderboardErrorJson(e: unknown, context: string): NextResponse {
  const err = (e ?? {}) as { message?: string; code?: string }
  const known = err.message ? RPC_ERRORS[err.message] : undefined
  if (known) return NextResponse.json({ error: known.error }, { status: known.status })
  if (err.code === "23514") return NextResponse.json({ error: "Those prize details are not allowed" }, { status: 400 })
  if (err.code === "23505") return NextResponse.json({ error: "That name is already used" }, { status: 409 })
  console.error(`[leaderboard-admin] ${context}:`, err.message ?? e)
  // Admin routes only: include the database's reason so a failure can be diagnosed from the page.
  const reason = err.message ? `: ${err.message.slice(0, 200)}` : ""
  return NextResponse.json({ error: `Something went wrong (${context})${reason}` }, { status: 500 })
}
