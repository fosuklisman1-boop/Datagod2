import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Board, DayRange, PeriodKind } from "./periods"
import type { PrizeFields, PrizeRow } from "./prizes"
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

/** Available bundles for the data-bundle prize picker. */
export async function listPrizePackages(db: SupabaseClient): Promise<{ id: string; network: string; name: string; size: string }[]> {
  const { data, error } = await db.from("packages").select("id, network, name, size").eq("is_available", true).order("network").order("price")
  if (error) throw error
  return (data ?? []) as { id: string; network: string; name: string; size: string }[]
}

export async function packageName(db: SupabaseClient, id: string): Promise<string | null> {
  const { data, error } = await db.from("packages").select("name, size, network").eq("id", id).maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as { name: string | null; size: string | null; network: string | null }
  return row.name?.trim() || [row.size, row.network, "bundle"].filter(Boolean).join(" ")
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

const RPC_ERRORS: Record<string, { status: number; error: string }> = {
  period_closed: { status: 409, error: "This period is closed. Its prizes can no longer change." },
  period_not_found: { status: 404, error: "Period not found" },
  prize_not_found: { status: 404, error: "Prize not found" },
  prize_already_cancelled: { status: 409, error: "That prize is already cancelled" },
}

/** Maps a database error from the leaderboard RPCs/tables to a JSON response. */
export function leaderboardErrorJson(e: unknown, context: string): NextResponse {
  const err = (e ?? {}) as { message?: string; code?: string }
  const known = err.message ? RPC_ERRORS[err.message] : undefined
  if (known) return NextResponse.json({ error: known.error }, { status: known.status })
  if (err.code === "23514") return NextResponse.json({ error: "Those prize details are not allowed" }, { status: 400 })
  if (err.code === "23505") return NextResponse.json({ error: "That name is already used" }, { status: 409 })
  console.error(`[leaderboard-admin] ${context}:`, err.message ?? e)
  return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
}
