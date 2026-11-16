/**
 * Recorder for blocked MTN numbers. Called from the checkout gate whenever a number is refused.
 * Must never slow or break checkout: the whole step races a 1,000 ms timeout and never throws.
 * Logs carry counts and error class names only, never phone numbers.
 *
 * The number-row write is ONE SQL call (public.record_mtn_blocked, migration 0182), so concurrent callers cannot
 * overwrite each other's attempts / first_blocked_at. This module only dedupes and builds the rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { getBlockedNumbersSettings, type BlockedNumbersSettings } from "./settings"
import { TRUSTED_PURCHASER_SURFACES, type BlockContext } from "./types"

const DEDUPE_WINDOW_MS = 10 * 60_000
const RECORD_TIMEOUT_MS = 1_000
const CHUNK = 500
const RECENT_LIMIT = 5000

/** One element of the p_rows array passed to public.record_mtn_blocked. */
export type RpcRow = {
  phone: string
  bump: 0 | 1 // 0 when the attempt is deduped, 1 otherwise
  providers: string[]
  surface: string
  shop_id: string | null
  retention_days: number
}

export type AttemptInsert = {
  phone: string
  surface: string
  shop_id: string | null
  user_id: string | null
  purchaser_phone: string | null
  product: string | null
  amount: number | null
}

export type RecordDeps = {
  db: SupabaseClient
  settings(): Promise<BlockedNumbersSettings>
  now(): Date
  afterInsert?(n: number): Promise<void>
}

export function dedupeKey(phone: string, surface: string, shopId?: string | null): string {
  return `${phone}|${surface}|${shopId ?? ""}`
}

export function planRecord(input: {
  phones: string[]
  ctx: BlockContext
  retentionDays: number
  providers?: string[]
  recentKeys: Set<string>
}): { rpcRows: RpcRow[]; attempts: AttemptInsert[]; deduped: number } {
  const { ctx, retentionDays, recentKeys } = input
  const providers = input.providers ?? []
  const shopId = ctx.shopId ?? null

  // Allowlist: only server-verified purchaser phones are kept (the preview endpoint and web forms are public).
  let purchaser: string | null = null
  if (TRUSTED_PURCHASER_SURFACES.includes(ctx.surface) && ctx.purchaserPhone) {
    purchaser = normalizeGhanaPhone(ctx.purchaserPhone)
  }

  const canon = new Set<string>()
  for (const raw of input.phones) {
    const p = typeof raw === "string" ? normalizeGhanaPhone(raw) : null
    if (p) canon.add(p)
  }

  const rpcRows: RpcRow[] = []
  const attempts: AttemptInsert[] = []
  let deduped = 0
  for (const phone of canon) {
    const isDup = recentKeys.has(dedupeKey(phone, ctx.surface, shopId))
    if (isDup) deduped++
    else
      attempts.push({
        phone,
        surface: ctx.surface,
        shop_id: shopId,
        user_id: ctx.userId ?? null,
        purchaser_phone: purchaser,
        product: ctx.product ?? null,
        amount: ctx.amount ?? null,
      })
    rpcRows.push({ phone, bump: isDup ? 0 : 1, providers, surface: ctx.surface, shop_id: shopId, retention_days: retentionDays })
  }
  return { rpcRows, attempts, deduped }
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function logErr(msg: string, err: unknown): void {
  console.error(msg, err instanceof Error ? err.name : "UnknownError")
}

const ZERO = { recorded: 0, deduped: 0 }

async function runRecord(
  phones: string[],
  ctx: BlockContext,
  providers: string[],
  deps: RecordDeps,
  state: { aborted: boolean; inserted: number }
): Promise<{ recorded: number; deduped: number }> {
  const settings = await deps.settings()
  if (!settings.enabled || state.aborted) return ZERO

  const canon = [
    ...new Set(phones.map((p) => (typeof p === "string" ? normalizeGhanaPhone(p) : null)).filter((p): p is string => !!p)),
  ]
  if (canon.length === 0) return ZERO
  const db = deps.db

  const recentKeys = new Set<string>()
  const since = new Date(deps.now().getTime() - DEDUPE_WINDOW_MS).toISOString()
  for (const part of chunks(canon, CHUNK)) {
    if (state.aborted) return ZERO
    const { data, error } = await db
      .from("mtn_blocked_attempts")
      .select("phone,surface,shop_id")
      .in("phone", part)
      .gte("created_at", since)
      .limit(RECENT_LIMIT)
    if (error) throw error
    for (const r of (data ?? []) as { phone: string; surface: string; shop_id: string | null }[]) {
      recentKeys.add(dedupeKey(r.phone, r.surface, r.shop_id))
    }
  }

  const plan = planRecord({ phones: canon, ctx, retentionDays: settings.retention_days, providers, recentKeys })

  const idByPhone = new Map<string, string>()
  for (const part of chunks(plan.rpcRows, CHUNK)) {
    if (state.aborted) return ZERO
    const { data, error } = await db.rpc("record_mtn_blocked", { p_rows: part })
    if (error) throw error
    for (const r of (data ?? []) as { id: string; phone: string }[]) idByPhone.set(r.phone, r.id)
  }
  if (idByPhone.size < plan.rpcRows.length) {
    console.warn("[blocked-numbers] rpc returned fewer ids than phones; missing:", plan.rpcRows.length - idByPhone.size)
  }

  const attemptRows = plan.attempts
    .filter((a) => idByPhone.has(a.phone))
    .map((a) => ({ ...a, blocked_number_id: idByPhone.get(a.phone) as string }))
  for (const part of chunks(attemptRows, CHUNK)) {
    if (state.aborted) return ZERO
    const { error } = await db.from("mtn_blocked_attempts").insert(part)
    if (error) throw error
  }

  state.inserted = attemptRows.length
  return { recorded: attemptRows.length, deduped: plan.deduped }
}

export async function recordBlockedRecipients(
  phones: string[],
  ctx: BlockContext,
  providers: string[],
  deps?: RecordDeps
): Promise<{ recorded: number; deduped: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const state = { aborted: false, inserted: 0 }
  try {
    const d: RecordDeps = deps ?? {
      db: supabaseAdmin as unknown as SupabaseClient,
      settings: () => getBlockedNumbersSettings(),
      now: () => new Date(),
      // Spike alert: throttled and never throws. Runs outside the recorder's 1 s race; its own read budget bounds it.
      afterInsert: async () => {
        const { spikeCheckAfterInsert } = await import("./alerts")
        await spikeCheckAfterInsert()
      },
    }
    if (!Array.isArray(phones) || phones.length === 0) return ZERO
    const work = runRecord(phones, ctx, providers, d, state).catch((err) => {
      logErr("[blocked-numbers] record failed:", err)
      return ZERO
    })
    const timeout = new Promise<typeof ZERO>((resolve) => {
      timer = setTimeout(() => {
        state.aborted = true
        console.warn("[blocked-numbers] record timed out; lost phones:", phones.length)
        resolve(ZERO)
      }, RECORD_TIMEOUT_MS)
    })
    const result = await Promise.race([work, timeout])
    if (state.inserted > 0 && !state.aborted && d.afterInsert) {
      // Fire-and-forget: the hook is not on the checkout path and must not eat the 1 s budget. Never throws.
      const hook = Promise.resolve()
        .then(() => d.afterInsert!(state.inserted))
        .catch((err) => logErr("[blocked-numbers] afterInsert hook failed:", err))
      try {
        after(() => hook) // keeps the hook alive in a request scope
      } catch {
        // outside a request scope (tests, scripts): the promise just runs
      }
    }
    return result
  } catch (err) {
    logErr("[blocked-numbers] record failed:", err)
    return ZERO
  } finally {
    if (timer) clearTimeout(timer)
  }
}
