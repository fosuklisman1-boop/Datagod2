/**
 * Re-check engine for blocked MTN numbers. Asks the checkout providers (the admin's order, strict batch calls)
 * whether a refused number is now allowed, and moves each row through the state machine.
 * Logs and results carry counts only, never phone numbers.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import {
  resolveVerdicts,
  getCustomerVerificationSettings,
  checkCustomerFacingVerificationDetailed,
  type CustomerVerificationSettings,
  type VerdictIo,
} from "@/lib/mtn-providers/customer-verification"
import { WHITELIST_REGISTRY, type WhitelistEntry } from "@/lib/mtn-providers/provider-whitelist"
import { setCachedVerdicts } from "@/lib/mtn-providers/verdict-cache"

const TABLE = "mtn_blocked_numbers"
const DAY_MS = 86_400_000
const CHUNK = 500
const DEFAULT_LIMIT = 2000
const RESOLVER_TIMEOUT_MS = 60_000

export type Patch = Record<string, string | number>

/** Pure state transition. null = leave the row untouched (unchecked). */
export function nextState(row: { recheck_count: number }, verdict: boolean | null, approvedBy: string | null, now: Date): Patch | null {
  if (verdict === null) return null
  const iso = now.toISOString()
  if (verdict === true) return { status: "allowed", allowed_at: iso, allowed_by: approvedBy ?? "unknown" }
  const nextCount = row.recheck_count + 1
  return {
    recheck_count: nextCount,
    next_recheck_at: new Date(now.getTime() + (nextCount < 7 ? 1 : 7) * DAY_MS).toISOString(),
    last_rechecked_at: iso,
  }
}

export type RecheckOpts = { ids?: string[]; all?: boolean; limit?: number; reopenExpired?: boolean }
export type RecheckResult = {
  checked: number
  allowed: number
  stillBlocked: number
  unchecked: number
  expired: number
  newlyAllowedIds: string[]
}

export type RecheckDeps = {
  db: SupabaseClient
  now(): Date
  getSettings(): Promise<CustomerVerificationSettings>
  registry: WhitelistEntry[]
  detailed: typeof checkCustomerFacingVerificationDetailed
  resolve: typeof resolveVerdicts
  setCache: typeof setCachedVerdicts
}

const realDeps = (): RecheckDeps => ({
  db: supabaseAdmin,
  now: () => new Date(),
  getSettings: getCustomerVerificationSettings,
  registry: WHITELIST_REGISTRY,
  detailed: checkCustomerFacingVerificationDetailed,
  resolve: resolveVerdicts,
  setCache: setCachedVerdicts,
})

type DueRow = { id: string; phone: string; recheck_count: number }

function chunked<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

export async function recheckBlockedNumbers(opts: RecheckOpts = {}, deps: RecheckDeps = realDeps()): Promise<RecheckResult> {
  const { db } = deps
  const now = deps.now()
  const nowIso = now.toISOString()
  const result: RecheckResult = { checked: 0, allowed: 0, stillBlocked: 0, unchecked: 0, expired: 0, newlyAllowedIds: [] }

  // 1. Expire blocked rows past their retention window.
  const exp = await db
    .from(TABLE)
    .update({ status: "expired", updated_at: nowIso })
    .eq("status", "blocked")
    .lt("expires_at", nowIso)
    .select("id")
  if (exp.error) throw new Error(`expire failed: ${exp.error.code ?? "db"}`)
  result.expired = exp.data?.length ?? 0

  // 2. Select the rows to check (bounded). Explicit ids skip the due filter.
  const statuses = opts.reopenExpired ? ["blocked", "expired"] : ["blocked"]
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT)
  let rows: DueRow[] = []
  if (opts.ids && opts.ids.length > 0) {
    for (const idChunk of chunked(opts.ids, CHUNK)) {
      const { data, error } = await db
        .from(TABLE)
        .select("id, phone, recheck_count")
        .in("status", statuses)
        .in("id", idChunk)
        .limit(CHUNK)
      if (error) throw new Error(`select failed: ${error.code ?? "db"}`)
      rows.push(...((data ?? []) as DueRow[]))
    }
  } else {
    const { data, error } = await db
      .from(TABLE)
      .select("id, phone, recheck_count")
      .in("status", statuses)
      .lte("next_recheck_at", nowIso)
      .order("next_recheck_at", { ascending: true })
      .limit(limit)
    if (error) throw new Error(`select failed: ${error.code ?? "db"}`)
    rows = (data ?? []) as DueRow[]
  }
  if (rows.length === 0) return result

  const settings = await deps.getSettings()

  // 3. Resolve verdicts in chunks of 500, 60 s timeout each.
  for (const part of chunked(rows, CHUNK)) {
    const approvedBy = new Map<string, string>()
    const io: VerdictIo = {
      settings: async () => settings,
      registry: deps.registry,
      timeoutMs: RESOLVER_TIMEOUT_MS,
      check: async (phones, registry, s) => {
        const detailed = await deps.detailed(phones, registry, s)
        for (const d of detailed) if (d.approvedBy) approvedBy.set(d.phone, d.approvedBy)
        return detailed.map(({ phone, verified }) => ({ phone, verified }))
      },
    }
    const verdicts = await deps.resolve(part.map((r) => r.phone), io)

    const flips = new Map<string, string[]>() // allowed_by -> ids
    const stillByCount = new Map<number, string[]>() // new recheck_count -> ids
    const allowedPhones = new Map<string, boolean>()
    for (const row of part) {
      const patch = nextState(row, verdicts.get(row.phone) ?? null, approvedBy.get(row.phone) ?? null, now)
      if (!patch) {
        result.unchecked++
      } else if (patch.status === "allowed") {
        const key = String(patch.allowed_by)
        flips.set(key, [...(flips.get(key) ?? []), row.id])
        allowedPhones.set(row.phone, true)
        result.newlyAllowedIds.push(row.id)
        result.allowed++
        result.checked++
      } else {
        const c = Number(patch.recheck_count)
        stillByCount.set(c, [...(stillByCount.get(c) ?? []), row.id])
        result.stillBlocked++
        result.checked++
      }
    }

    // Writes grouped by identical patch, guarded on status so a row an admin handled mid-run is not overwritten.
    // No updated_at trigger exists on the table, so every write stamps it.
    for (const [allowedBy, ids] of flips) {
      const patch = nextState({ recheck_count: 0 }, true, allowedBy, now)!
      for (const idChunk of chunked(ids, CHUNK)) {
        const { error } = await db.from(TABLE).update({ ...patch, updated_at: nowIso }).in("id", idChunk).in("status", statuses)
        if (error) console.error("[BLOCKED-RECHECK] flip update failed:", error.code ?? "db")
      }
    }
    for (const [count, ids] of stillByCount) {
      const patch = nextState({ recheck_count: count - 1 }, false, null, now)!
      for (const idChunk of chunked(ids, CHUNK)) {
        const { error } = await db.from(TABLE).update({ ...patch, updated_at: nowIso }).in("id", idChunk).in("status", statuses)
        if (error) console.error("[BLOCKED-RECHECK] schedule update failed:", error.code ?? "db")
      }
    }

    if (allowedPhones.size > 0) {
      try {
        await deps.setCache(allowedPhones, settings.providers)
      } catch {
        console.error("[BLOCKED-RECHECK] verdict cache write failed")
      }
    }
  }

  console.log(
    `[BLOCKED-RECHECK] expired=${result.expired} checked=${result.checked} allowed=${result.allowed} stillBlocked=${result.stillBlocked} unchecked=${result.unchecked}`,
  )
  return result
}
