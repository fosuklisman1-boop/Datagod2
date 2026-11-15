/**
 * Recorder for blocked MTN numbers. Called from the checkout gate whenever a number is refused.
 * Must never slow or break checkout: the whole step races a 1,000 ms timeout and never throws.
 * Logs carry counts and error class names only, never phone numbers.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { getBlockedNumbersSettings, type BlockedNumbersSettings } from "./settings"
import { DEALER_SURFACES, PREVIEW_SURFACES, type BlockContext } from "./types"

const DAY_MS = 86_400_000
const DEDUPE_WINDOW_MS = 10 * 60_000
const RECORD_TIMEOUT_MS = 1_000
const CHUNK = 500

export type ExistingRow = {
  phone: string
  status: "blocked" | "allowed" | "expired" | "handled"
  attempts: number
  first_blocked_at: string
  expires_at: string | null
  recheck_count: number
  next_recheck_at: string | null
  customer_notified_at: string | null
}

/**
 * Every row in one upsert has this exact shape (PostgREST overwrites each column sent, and a column missing from a
 * bulk row would be reset to its default). Columns NOT listed here (ready_sms_count, ready_sms_window_start, allowed_by,
 * allowed_at, notes, submitted_*, handled_*, last_rechecked_at, notify_attempts, customer_notify_phone, created_at)
 * are never sent, so a conflict leaves them untouched.
 */
export type NumberUpsert = {
  phone: string
  status: "blocked"
  first_blocked_at: string
  last_blocked_at: string
  attempts: number
  providers_rejected: string[]
  recheck_count: number
  next_recheck_at: string
  expires_at: string
  customer_notified_at: string | null
  last_surface: string
  last_shop_id: string | null
  updated_at: string
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
  now: Date
  retentionDays: number
  providers?: string[]
  recentKeys: Set<string>
  existing: Map<string, ExistingRow>
}): { numberUpserts: NumberUpsert[]; attempts: AttemptInsert[]; deduped: number } {
  const { ctx, now, retentionDays, recentKeys, existing } = input
  const providers = input.providers ?? []
  const nowIso = now.toISOString()
  const nextRecheck = new Date(now.getTime() + DAY_MS).toISOString()
  const freshExpiry = new Date(now.getTime() + retentionDays * DAY_MS).toISOString()
  const shopId = ctx.shopId ?? null

  // Web and preview surfaces never trust a purchaser phone (the preview endpoint is public).
  let purchaser: string | null = null
  const untrusted = PREVIEW_SURFACES.includes(ctx.surface) || DEALER_SURFACES.includes(ctx.surface)
  if (!untrusted && ctx.purchaserPhone) purchaser = normalizeGhanaPhone(ctx.purchaserPhone)

  const canon = new Set<string>()
  for (const raw of input.phones) {
    const p = typeof raw === "string" ? normalizeGhanaPhone(raw) : null
    if (p) canon.add(p)
  }

  const numberUpserts: NumberUpsert[] = []
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

    const prev = existing.get(phone)
    const bump = isDup ? 0 : 1
    const common = {
      phone,
      status: "blocked" as const,
      last_blocked_at: nowIso,
      providers_rejected: providers,
      last_surface: ctx.surface,
      last_shop_id: shopId,
      updated_at: nowIso,
    }
    if (!prev) {
      numberUpserts.push({
        ...common,
        first_blocked_at: nowIso,
        attempts: 1,
        recheck_count: 0,
        next_recheck_at: nextRecheck,
        expires_at: freshExpiry,
        customer_notified_at: null,
      })
    } else if (prev.status === "blocked") {
      numberUpserts.push({
        ...common,
        first_blocked_at: prev.first_blocked_at,
        attempts: prev.attempts + bump,
        recheck_count: prev.recheck_count,
        next_recheck_at: prev.next_recheck_at ?? nextRecheck,
        expires_at: prev.expires_at ?? freshExpiry,
        customer_notified_at: prev.customer_notified_at,
      })
    } else {
      // allowed / expired / handled and blocked again: back to blocked with a fresh schedule.
      numberUpserts.push({
        ...common,
        first_blocked_at: prev.first_blocked_at,
        attempts: prev.attempts + bump,
        recheck_count: 0,
        next_recheck_at: nextRecheck,
        expires_at: freshExpiry,
        customer_notified_at: null,
      })
    }
  }
  return { numberUpserts, attempts, deduped }
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function logErr(msg: string, err: unknown): void {
  console.error(msg, err instanceof Error ? err.name : "UnknownError")
}

async function runRecord(
  phones: string[],
  ctx: BlockContext,
  providers: string[],
  deps: RecordDeps
): Promise<{ recorded: number; deduped: number }> {
  const settings = await deps.settings()
  if (!settings.enabled) return { recorded: 0, deduped: 0 }

  const canon = [
    ...new Set(
      phones.map((p) => (typeof p === "string" ? normalizeGhanaPhone(p) : null)).filter((p): p is string => !!p)
    ),
  ]
  if (canon.length === 0) return { recorded: 0, deduped: 0 }
  const now = deps.now()
  const db = deps.db

  const existing = new Map<string, ExistingRow>()
  const recentKeys = new Set<string>()
  const since = new Date(now.getTime() - DEDUPE_WINDOW_MS).toISOString()
  for (const part of chunks(canon, CHUNK)) {
    const { data: rows, error } = await db
      .from("mtn_blocked_numbers")
      .select("phone,status,attempts,first_blocked_at,expires_at,recheck_count,next_recheck_at,customer_notified_at")
      .in("phone", part)
    if (error) throw error
    for (const r of (rows ?? []) as ExistingRow[]) existing.set(r.phone, r)

    const { data: recent, error: rErr } = await db
      .from("mtn_blocked_attempts")
      .select("phone,surface,shop_id")
      .in("phone", part)
      .gte("created_at", since)
    if (rErr) throw rErr
    for (const r of (recent ?? []) as { phone: string; surface: string; shop_id: string | null }[]) {
      recentKeys.add(dedupeKey(r.phone, r.surface, r.shop_id))
    }
  }

  const plan = planRecord({
    phones: canon,
    ctx,
    now,
    retentionDays: settings.retention_days,
    providers,
    recentKeys,
    existing,
  })

  // The upsert returns the ids, so no separate re-select is needed.
  const idByPhone = new Map<string, string>()
  for (const part of chunks(plan.numberUpserts, CHUNK)) {
    const { data, error } = await db.from("mtn_blocked_numbers").upsert(part, { onConflict: "phone" }).select("id,phone")
    if (error) throw error
    for (const r of (data ?? []) as { id: string; phone: string }[]) idByPhone.set(r.phone, r.id)
  }

  const attemptRows = plan.attempts
    .filter((a) => idByPhone.has(a.phone))
    .map((a) => ({ ...a, blocked_number_id: idByPhone.get(a.phone) as string }))
  for (const part of chunks(attemptRows, CHUNK)) {
    const { error } = await db.from("mtn_blocked_attempts").insert(part)
    if (error) throw error
  }

  if (attemptRows.length > 0 && deps.afterInsert) {
    try {
      await deps.afterInsert(attemptRows.length)
    } catch (err) {
      logErr("[blocked-numbers] afterInsert hook failed:", err)
    }
  }
  return { recorded: attemptRows.length, deduped: plan.deduped }
}

export async function recordBlockedRecipients(
  phones: string[],
  ctx: BlockContext,
  providers: string[],
  deps?: RecordDeps
): Promise<{ recorded: number; deduped: number }> {
  const zero = { recorded: 0, deduped: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const d: RecordDeps = deps ?? {
      db: supabaseAdmin as unknown as SupabaseClient,
      settings: () => getBlockedNumbersSettings(),
      now: () => new Date(),
    }
    if (!Array.isArray(phones) || phones.length === 0) return zero
    const work = runRecord(phones, ctx, providers, d).catch((err) => {
      logErr("[blocked-numbers] record failed:", err)
      return zero
    })
    const timeout = new Promise<typeof zero>((resolve) => {
      timer = setTimeout(() => {
        console.warn("[blocked-numbers] record timed out; lost phones:", phones.length)
        resolve(zero)
      }, RECORD_TIMEOUT_MS)
    })
    return await Promise.race([work, timeout])
  } catch (err) {
    logErr("[blocked-numbers] record failed:", err)
    return zero
  } finally {
    if (timer) clearTimeout(timer)
  }
}
