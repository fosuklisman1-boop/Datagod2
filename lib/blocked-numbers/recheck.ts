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
import { getBlockedNumbersSettings } from "./settings"
import { checkAllProviders, type AllProvidersResult } from "./all-providers"
import { markAllowedByAdminCheck, type AdminAllowRow } from "./admin-allow"

const TABLE = "mtn_blocked_numbers"
const DAY_MS = 86_400_000
const CHUNK = 500
const OUTSIDE_BATCH = 100
/** No outside-provider batch starts after this long from run start (leaves the cron its notify window). */
export const OUTSIDE_START_DEADLINE_MS = 150_000
/** Cumulative time the outside pass may spend; no new batch starts once spent. */
export const OUTSIDE_BUDGET_MS = 90_000
const DEFAULT_LIMIT = 2000
const EXPIRE_LIMIT = 2000
const RESOLVER_TIMEOUT_MS = 60_000
const RUN_DEADLINE_MS = 200_000

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
  /** Rows not started because the run deadline passed; they stay due. */
  deferred: number
  newlyAllowedIds: string[]
}

export type RecheckDeps = {
  db: SupabaseClient
  now(): Date
  /** Milliseconds clock, injected so the run deadline is testable. */
  clock(): number
  getSettings(): Promise<CustomerVerificationSettings>
  getBlockedSettings(): Promise<{ retention_days: number }>
  registry: WhitelistEntry[]
  detailed: typeof checkCustomerFacingVerificationDetailed
  resolve: typeof resolveVerdicts
  setCache: typeof setCachedVerdicts
  /** Ask every configured provider (incl. outside the checkout list). Optional: absent = no outside pass. */
  checkAll?: (phones: string[]) => Promise<AllProvidersResult>
  markAllowed?: (rows: AdminAllowRow[]) => Promise<{ updatedIds: string[]; failed: boolean; cacheFailed: number }>
}

const realDeps = (): RecheckDeps => ({
  db: supabaseAdmin,
  now: () => new Date(),
  clock: () => Date.now(),
  getSettings: getCustomerVerificationSettings,
  getBlockedSettings: getBlockedNumbersSettings,
  registry: WHITELIST_REGISTRY,
  detailed: checkCustomerFacingVerificationDetailed,
  resolve: resolveVerdicts,
  setCache: setCachedVerdicts,
  checkAll: (phones) => checkAllProviders(phones),
  markAllowed: (rows) => markAllowedByAdminCheck(rows),
})

type DueRow = { id: string; phone: string; recheck_count: number; status: string }

function chunked<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

export async function recheckBlockedNumbers(opts: RecheckOpts = {}, deps: RecheckDeps = realDeps()): Promise<RecheckResult> {
  const { db } = deps
  const startedAt = deps.clock()
  const now = deps.now()
  const nowIso = now.toISOString()
  const result: RecheckResult = { checked: 0, allowed: 0, stillBlocked: 0, unchecked: 0, expired: 0, deferred: 0, newlyAllowedIds: [] }

  // 1. Expire blocked rows past their retention window: bounded id select, then guarded chunked updates.
  const expSel = await db.from(TABLE).select("id").eq("status", "blocked").lt("expires_at", nowIso).limit(EXPIRE_LIMIT)
  if (expSel.error) throw new Error(`expire select failed: ${expSel.error.code ?? "db"}`)
  const expireIds = ((expSel.data ?? []) as Array<{ id: string }>).map((r) => r.id)
  for (const idChunk of chunked(expireIds, CHUNK)) {
    const upd = await db
      .from(TABLE)
      .update({ status: "expired", updated_at: nowIso })
      .in("id", idChunk)
      .eq("status", "blocked")
      .select("id")
    if (upd.error) {
      console.error("[BLOCKED-RECHECK] expire update failed:", upd.error.code ?? "db")
      continue
    }
    result.expired += upd.data?.length ?? 0
  }

  // 2. Select the rows to check (bounded). Explicit ids skip the due filter.
  const reopen = opts.reopenExpired === true
  const statuses = reopen ? ["blocked", "expired"] : ["blocked"]
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT)
  const cols = "id, phone, recheck_count, status"
  let rows: DueRow[] = []
  if (opts.ids && opts.ids.length > 0) {
    for (const idChunk of chunked(opts.ids, CHUNK)) {
      const { data, error } = await db.from(TABLE).select(cols).in("status", statuses).in("id", idChunk).limit(CHUNK)
      if (error) throw new Error(`select failed: ${error.code ?? "db"}`)
      rows.push(...((data ?? []) as DueRow[]))
    }
  } else {
    let q = db.from(TABLE).select(cols)
    q = reopen
      ? q.or(`and(status.eq.blocked,next_recheck_at.lte.${nowIso}),status.eq.expired`)
      : q.in("status", statuses).lte("next_recheck_at", nowIso)
    const { data, error } = await q.order("next_recheck_at", { ascending: true, nullsFirst: true }).limit(limit)
    if (error) throw new Error(`select failed: ${error.code ?? "db"}`)
    rows = (data ?? []) as DueRow[]
  }
  if (rows.length === 0) return result

  const settings = await deps.getSettings()
  const retentionDays = reopen ? (await deps.getBlockedSettings()).retention_days : 0
  const reopenExpiresAt = new Date(now.getTime() + retentionDays * DAY_MS).toISOString()

  const refusedRows: DueRow[] = [] // definite checkout refusals (never null/outage), for the outside pass

  // 3. Resolve verdicts in chunks of 500, 60 s timeout each; stop starting chunks after the run deadline.
  for (const part of chunked(rows, CHUNK)) {
    if (deps.clock() - startedAt >= RUN_DEADLINE_MS) {
      result.deferred += part.length
      continue
    }
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

    for (const row of part) if (verdicts.get(row.phone) === false) refusedRows.push(row)

    const flips = new Map<string, DueRow[]>() // `${allowed_by}|${status}` -> rows
    const stills = new Map<string, DueRow[]>() // `${new count}|${status}` -> rows
    for (const row of part) {
      const patch = nextState(row, verdicts.get(row.phone) ?? null, approvedBy.get(row.phone) ?? null, now)
      if (!patch) {
        result.unchecked++
      } else if (patch.status === "allowed") {
        const k = `${patch.allowed_by}|${row.status}`
        flips.set(k, [...(flips.get(k) ?? []), row])
      } else {
        const k = `${patch.recheck_count}|${row.status}`
        stills.set(k, [...(stills.get(k) ?? []), row])
      }
    }

    // Writes grouped by identical patch, guarded on the row's status so a row an admin handled mid-run is not
    // overwritten. Only rows the write actually returned count. No updated_at trigger exists, so stamp it.
    const allowedPhones = new Map<string, boolean>()
    for (const [k, group] of flips) {
      const sep = k.lastIndexOf("|")
      const allowedBy = k.slice(0, sep)
      const status = k.slice(sep + 1)
      const patch = nextState({ recheck_count: 0 }, true, allowedBy, now)!
      for (const rowChunk of chunked(group, CHUNK)) {
        const { data, error } = await db
          .from(TABLE)
          .update({ ...patch, updated_at: nowIso })
          .in("id", rowChunk.map((r) => r.id))
          .eq("status", status)
          .select("id")
        if (error) {
          console.error("[BLOCKED-RECHECK] flip update failed:", error.code ?? "db")
          result.unchecked += rowChunk.length
          continue
        }
        const done = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
        for (const r of rowChunk) {
          if (!done.has(r.id)) continue
          allowedPhones.set(r.phone, true)
          result.newlyAllowedIds.push(r.id)
          result.allowed++
          result.checked++
        }
      }
    }
    for (const [k, group] of stills) {
      const sep = k.lastIndexOf("|")
      const count = Number(k.slice(0, sep))
      const status = k.slice(sep + 1)
      const patch = nextState({ recheck_count: count - 1 }, false, null, now)!
      // An expired row that is explicitly re-checked and still refused is re-opened for a fresh retention window.
      const reopened = status === "expired" ? { status: "blocked", expires_at: reopenExpiresAt } : {}
      for (const rowChunk of chunked(group, CHUNK)) {
        const { data, error } = await db
          .from(TABLE)
          .update({ ...patch, ...reopened, updated_at: nowIso })
          .in("id", rowChunk.map((r) => r.id))
          .eq("status", status)
          .select("id")
        if (error) {
          console.error("[BLOCKED-RECHECK] schedule update failed:", error.code ?? "db")
          result.unchecked += rowChunk.length
          continue
        }
        const n = data?.length ?? 0
        result.stillBlocked += n
        result.checked += n
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

  // 4. Outside pass, AFTER every checkout part so it can never defer them. Rows the checkout list refused are
  // asked of all providers (batches of <=100); an approval flips through markAllowedByAdminCheck (verdict
  // written and read back first, then guarded flip). No batch starts after 150 s from run start or once 90 s
  // of outside time has been spent. The row was already scheduled above, so a flip moves it from stillBlocked.
  if (deps.checkAll && deps.markAllowed && refusedRows.length > 0) {
    let outsideSpent = 0
    for (const batch of chunked(refusedRows, OUTSIDE_BATCH)) {
      if (deps.clock() - startedAt >= OUTSIDE_START_DEADLINE_MS || outsideSpent >= OUTSIDE_BUDGET_MS) break
      const batchStart = deps.clock()
      try {
        const all = await deps.checkAll(batch.map((row) => row.phone))
        const byPhone = new Map(all.rows.map((x) => [x.phone, x]))
        const candidates = batch.flatMap((row) => {
          const by = byPhone.get(row.phone)?.allowedOutsideCheckout?.[0]
          return by ? [{ id: row.id, phone: row.phone, allowedBy: by }] : []
        })
        if (candidates.length > 0) {
          const done = await deps.markAllowed(candidates)
          for (const id of done.updatedIds) {
            result.newlyAllowedIds.push(id)
            result.allowed++
            result.stillBlocked = Math.max(0, result.stillBlocked - 1)
          }
        }
      } catch {
        console.error("[BLOCKED-RECHECK] outside provider check failed")
      }
      outsideSpent += deps.clock() - batchStart
    }
  }

  console.log(
    `[BLOCKED-RECHECK] expired=${result.expired} checked=${result.checked} allowed=${result.allowed} stillBlocked=${result.stillBlocked} unchecked=${result.unchecked} deferred=${result.deferred}`,
  )
  return result
}
