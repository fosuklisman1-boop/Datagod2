/**
 * Live, customer-facing phone-number verification preview at checkout.
 *
 * Deliberately independent of the internal fulfillment-time whitelist gate
 * (lib/mtn-fulfillment.ts's mtn_whitelist_enabled check) — its own admin
 * toggle, its own provider subset, its own admin_settings key. The two can
 * disagree occasionally; that's an accepted trade-off for independent
 * control, not a bug (see docs/superpowers/specs/2026-09-05-live-phone-
 * verification-checkout-design.md).
 *
 * Stateless — no persistence. The "you'll receive it once verified" promise
 * shown to customers is backed entirely by the EXISTING internal gate + its
 * 24h/72h retry cron, which runs on every order regardless of this preview.
 *
 * Fails open at every layer: disabled feature, unconfigured providers, a
 * provider erroring, or an unreadable setting all resolve to "verified".
 */

import { after } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { normalizePhoneNumber } from "@/lib/mtn-fulfillment"
import { WHITELIST_REGISTRY, type WhitelistEntry } from "./provider-whitelist"
import { getCachedVerdicts, setCachedVerdicts } from "./verdict-cache"
import { recordBlockedRecipients } from "@/lib/blocked-numbers/record"
import type { BlockContext } from "@/lib/blocked-numbers/types"
import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { isStrictVerifyOn } from "@/lib/strict-verify/settings"
import { getFreshVerdicts, saveVerdicts } from "@/lib/strict-verify/verdicts"
import { askSupplier } from "@/lib/strict-verify/ask"

export const SETTING_KEY = "customer_verification_settings"

export type CustomerVerificationSettings = {
  enabled: boolean
  providers: string[]
  /** When on, a number the selected providers positively reject can't be ordered (not just warned). */
  block_unverified?: boolean
}

const DEFAULT_SETTINGS: CustomerVerificationSettings = { enabled: false, providers: [], block_unverified: false }

export async function getCustomerVerificationSettings(): Promise<CustomerVerificationSettings> {
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", SETTING_KEY)
      .maybeSingle()

    const value = data?.value
    if (!value || typeof value.enabled !== "boolean" || !Array.isArray(value.providers)) {
      return DEFAULT_SETTINGS
    }
    return { enabled: value.enabled, providers: value.providers, block_unverified: value.block_unverified === true }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/**
 * Checks each phone against the admin-selected, registry-configured
 * providers IN THE ADMIN'S ORDER — verified as soon as any one approves; a
 * number a provider rejects, or a provider that fails, moves on to the next. Uses each provider's
 * batch endpoint where available (one HTTP call for most providers, not
 * one per phone — Apex Prime has no native batch endpoint and loops
 * internally, a pre-existing constraint of that provider's integration)
 * so a large phone list doesn't fan out into hundreds of real API calls.
 * A provider whose checkBatch() throws simply doesn't count as an
 * approval for any phone still pending; it never fails the whole check.
 *
 * `settings` and `registry` are optional purely for testability (inject a
 * fake registry/settings instead of hitting the DB and real provider
 * APIs) — production callers omit both and get the real registry + a
 * fresh settings read every call.
 */
export async function checkCustomerFacingVerification(
  phones: string[],
  registry: WhitelistEntry[] = WHITELIST_REGISTRY,
  settings?: CustomerVerificationSettings
): Promise<Array<{ phone: string; verified: boolean }>> {
  const detailed = await checkCustomerFacingVerificationDetailed(phones, registry, settings)
  return detailed.map(({ phone, verified }) => ({ phone, verified }))
}

/**
 * Same check as checkCustomerFacingVerification, also reporting which provider
 * (the first, in admin order, whose batch approved it) verified each phone;
 * null when the phone is not verified or the check failed open.
 */
export async function checkCustomerFacingVerificationDetailed(
  phones: string[],
  registry: WhitelistEntry[] = WHITELIST_REGISTRY,
  settings?: CustomerVerificationSettings
): Promise<Array<{ phone: string; verified: boolean; approvedBy: string | null }>> {
  const resolvedSettings = settings ?? await getCustomerVerificationSettings()

  if (!resolvedSettings.enabled || resolvedSettings.providers.length === 0) {
    return phones.map(phone => ({ phone, verified: true, approvedBy: null }))
  }

  // The admin's order is the check order: ask the first selected provider, and
  // only move to the next for numbers it didn't approve (or when it failed).
  const configured = resolvedSettings.providers
    .map(name => registry.find(p => p.name === name))
    .filter((p): p is WhitelistEntry => !!p && p.configured())
  if (configured.length === 0) {
    return phones.map(phone => ({ phone, verified: true, approvedBy: null }))
  }

  // Dedupe so a repeated phone in the input is only ever checked once against
  // the providers, no matter how many times it appears in `phones`.
  const uniquePhones = [...new Set(phones)]

  const verifiedSet = new Set<string>()
  const approvedByMap = new Map<string, string>()
  let remaining = uniquePhones

  for (const provider of configured) {
    if (remaining.length === 0) break
    try {
      // Strict: a provider failure throws (caught below) instead of failing open
      // to "allowed", so the next provider still gets asked.
      const batchResults = await (provider.checkBatchStrict ?? provider.checkBatch)(remaining)
      // Match by normalized form, not exact string equality — some providers
      // (e.g. AgentPortalGH) echo back a differently-formatted number than
      // what was sent (e.g. 233551234567 for an input of 0551234567), which
      // would otherwise silently drop a genuine approval and show the
      // customer a false "not yet verified" warning for a number that's
      // actually fine.
      const remainingByNormalized = new Map(remaining.map(p => [normalizePhoneNumber(p), p]))
      for (const r of batchResults) {
        if (!r.allowed) continue
        const original = remainingByNormalized.get(normalizePhoneNumber(r.msisdn))
        if (original) {
          verifiedSet.add(original)
          if (!approvedByMap.has(original)) approvedByMap.set(original, provider.name)
        }
      }
      remaining = remaining.filter(p => !verifiedSet.has(p))
    } catch {
      // this provider's batch failure doesn't count as approval for anyone
      // still pending; move on to the next provider with the same remaining set
    }
  }

  return phones.map(phone => ({
    phone,
    verified: verifiedSet.has(phone),
    approvedBy: approvedByMap.get(phone) ?? null,
  }))
}

// ── Order-time verdicts + blocking ────────────────────────────────────────────

export const NOT_VERIFIED_MESSAGE =
  "This MTN number is not verified for data and can't be ordered. Please use a different number."
export const NOT_VERIFIED_CODE = "NUMBER_NOT_VERIFIED"
/** USSD / WhatsApp re-prompt when a typed recipient is blocked. */
export const RECIPIENT_BLOCKED_PROMPT = "This MTN number is not verified for data.\nEnter a different number:\n\n0. Back"

export function isBlockingOn(s: CustomerVerificationSettings): boolean {
  return s.enabled && s.block_unverified === true && s.providers.length > 0
}

export interface VerdictIo {
  settings(): Promise<CustomerVerificationSettings>
  registry: WhitelistEntry[]
  /** The shared guard (checkCustomerFacingVerification); receives the WRAPPED registry. */
  check(phones: string[], registry: WhitelistEntry[], settings: CustomerVerificationSettings): Promise<Array<{ phone: string; verified: boolean }>>
  timeoutMs: number
  /** Strict verification: called for each definite per-supplier answer (phone normalised to 0XXXXXXXXX). */
  onAnswer?: (supplier: string, phone: string, verdict: "yes" | "no") => void
}

/** Error class name only: provider errors can carry phone numbers. */
function errName(err: unknown): string {
  return err instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "UnknownError"
}

/**
 * Per-number verdict: true verified, false POSITIVELY rejected, null unchecked.
 * Contract: FAIL OPEN. Feature off, no configured provider, an error or a
 * timeout yields null for every number; only a positive negative yields false.
 *
 * Outage detection without editing the shared guard: the guard reports
 * verified:false when every provider's checkBatch THREW (it treats a throw
 * as "no approval"). Each registry entry is wrapped to count answers; the
 * guard sends every still-unverified number to every provider in turn, so a
 * verified:false is only trusted when at least one provider ANSWERED.
 * Otherwise the number is unchecked (null).
 * Never throws; logs a fixed string with the error class name only.
 */
export async function resolveVerdicts(phones: string[], io: VerdictIo): Promise<Map<string, boolean | null>> {
  const unchecked = () => new Map<string, boolean | null>(phones.map((l) => [l, null]))
  if (phones.length === 0) return new Map()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const settings = await io.settings()
    if (!settings.enabled || settings.providers.length === 0) return unchecked()
    if (!io.registry.some((p) => settings.providers.includes(p.name) && p.configured())) return unchecked()
    let answered = 0
    const wrapped: WhitelistEntry[] = io.registry.map((p) => ({
      ...p,
      checkBatch: async (msisdns: string[]) => {
        const r = await (p.checkBatchStrict ?? p.checkBatch)(msisdns)
        answered++
        if (io.onAnswer) {
          const asked = new Set(msisdns.map((m) => normalizeGhanaPhone(m)).filter((x): x is string => !!x))
          for (const row of Array.isArray(r) ? r : []) {
            const n = normalizeGhanaPhone(String(row?.msisdn ?? ""))
            if (n && asked.has(n) && typeof row.allowed === "boolean") io.onAnswer(p.name, n, row.allowed ? "yes" : "no")
          }
        }
        return r
      },
      checkBatchStrict: undefined,
    }))
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), io.timeoutMs)
    })
    const results = await Promise.race([io.check(phones, wrapped, settings), timeout])
    const out = unchecked()
    for (const r of results) {
      if (!out.has(r.phone)) continue
      if (r.verified === true) out.set(r.phone, true)
      else if (answered > 0) out.set(r.phone, false)
      // else: every provider threw -> outage -> stays null (unchecked)
    }
    return out
  } catch (err) {
    console.error("[CUSTOMER-VERIFICATION] verification unavailable (failing open):", errName(err))
    return unchecked()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Runs `task` out of band: opts.defer, else after(); outside a request scope after() throws, so await it. */
async function runDeferred(defer: ((task: () => Promise<unknown>) => void) | undefined, task: () => Promise<unknown>): Promise<void> {
  if (defer) { defer(task); return }
  let deferred = false
  try {
    after(task)
    deferred = true
  } catch {
    deferred = false
  }
  if (!deferred) await task()
}

export const STRICT_BACKGROUND_MAX_PHONES = 20
const STRICT_BACKGROUND_CONCURRENCY = 3
/** Hubnet's rate limit trips a shared cooldown that also blocks live sends: cap its asks per background task. */
export const STRICT_BACKGROUND_HUBNET_MAX = 5
/** Longest the response path waits for the main-check answers to be saved. */
export const STRICT_MAIN_SAVE_WAIT_MS = 1_000

/** Saves the main-check answers, waiting at most STRICT_MAIN_SAVE_WAIT_MS. Never throws; the deferred task saves again. */
async function saveMainAnswersBounded(db: SupabaseClient, rows: Array<{ phone: string; supplier: string; verdict: "yes" | "no" }>): Promise<void> {
  if (rows.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const save = saveVerdicts(db, [...rows], new Date()).catch((err) => {
      console.error("[CUSTOMER-VERIFICATION] strict main-answer save failed:", errName(err))
    })
    const wait = new Promise<void>((resolve) => { timer = setTimeout(resolve, STRICT_MAIN_SAVE_WAIT_MS) })
    await Promise.race([save, wait])
  } catch (err) {
    console.error("[CUSTOMER-VERIFICATION] strict main-answer save failed:", errName(err))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Suppliers switched off by the admin; null when the read fails (then nobody is asked). */
async function readDisabledSuppliers(db: SupabaseClient): Promise<Set<string> | null> {
  try {
    const { data, error } = await db.from("admin_settings").select("value").eq("key", "mtn_disabled_providers").maybeSingle()
    if (error) return null
    const list = (data as { value?: { providers?: unknown } } | null)?.value?.providers
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [])
  } catch {
    return null
  }
}

/**
 * Background step of strict verification. Saves the main-check answers, then
 * asks each checkout supplier that did not answer a phone and has no fresh
 * saved verdict, saving definite answers after every phone. At most 20 phones
 * per checkout (the send step asks the rest), 3 at a time; once Hubnet gives
 * no_answer it is not asked again. Never throws; logs no phone numbers.
 */
async function strictBackground(
  phones: string[],
  providers: string[],
  mainAnswers: Array<{ phone: string; supplier: string; verdict: "yes" | "no" }>,
  db: SupabaseClient,
  ask: (supplier: string, phone: string) => Promise<"yes" | "no" | "no_answer">
): Promise<void> {
  try {
    await saveVerdicts(db, mainAnswers, new Date())
    const disabled = await readDisabledSuppliers(db)
    if (!disabled) return
    const suppliers = providers.filter((s) => !disabled.has(s))
    if (suppliers.length === 0) return
    const queue = phones.slice(0, STRICT_BACKGROUND_MAX_PHONES)
    let hubnetStopped = false
    let hubnetAsks = 0
    const worker = async () => {
      for (let phone = queue.shift(); phone !== undefined; phone = queue.shift()) {
        try {
          const norm = normalizeGhanaPhone(phone)
          if (!norm) continue
          const answered = new Set(mainAnswers.filter((a) => a.phone === norm).map((a) => a.supplier))
          const candidates = suppliers.filter((s) => !answered.has(s))
          if (candidates.length === 0) continue
          const fresh = await getFreshVerdicts(db, norm, candidates, new Date())
          const rows: Array<{ phone: string; supplier: string; verdict: "yes" | "no" }> = []
          for (const s of candidates) {
            if (fresh.has(s)) continue
            if (s === "hubnet") {
              if (hubnetStopped || hubnetAsks >= STRICT_BACKGROUND_HUBNET_MAX) continue
              hubnetAsks++ // counted before the await: the 3 workers share the cap
            }
            const a = await ask(s, norm)
            if (a === "yes" || a === "no") rows.push({ phone: norm, supplier: s, verdict: a })
            else if (s === "hubnet") hubnetStopped = true
          }
          await saveVerdicts(db, rows, new Date())
        } catch (err) {
          console.error("[CUSTOMER-VERIFICATION] strict background phone failed:", errName(err))
        }
      }
    }
    await Promise.all(Array.from({ length: STRICT_BACKGROUND_CONCURRENCY }, worker))
  } catch (err) {
    console.error("[CUSTOMER-VERIFICATION] strict background check failed:", errName(err))
  }
}

export type OrderVerification = {
  verdicts: Map<string, boolean | null>
  /** The admin "block unverified numbers" toggle is in effect. */
  blocking: boolean
  /** Deduped numbers that must not be ordered (empty unless blocking). */
  blocked: string[]
}

/**
 * The order-time gate every ordering surface shares. Only a positive reject
 * blocks, and only with the toggle on; outages and timeouts never block (the
 * fulfillment-time hold stays the backstop). Never throws.
 * `registry`/`settings` are injectable for tests.
 */
export async function verifyRecipientsForOrder(
  phones: string[],
  opts: {
    timeoutMs?: number
    registry?: WhitelistEntry[]
    settings?: CustomerVerificationSettings
    /** When set, blocked numbers are recorded for the admin blocked-numbers view. */
    context?: BlockContext | (() => Promise<BlockContext | null>)
    /** Run the recording out of band instead of awaiting it. Defaults to next/server after() when a context is given. */
    defer?: (task: () => Promise<unknown>) => void
    /** Test seams for the strict per-supplier recording. */
    strictDb?: SupabaseClient
    ask?: typeof askSupplier
    /**
     * Strict mode only: start the out-of-band supplier asks (default true). The unauthenticated preview endpoint
     * passes false so anonymous callers cannot spend supplier rate limits or grow the verdict table; the
     * main-check answers are still saved (they cost no extra supplier calls).
     */
    strictBackground?: boolean
  } = {}
): Promise<OrderVerification> {
  try {
    const settings = opts.settings ?? await getCustomerVerificationSettings()
    // Definite verdicts from a recent check (possibly one that finished after an
    // earlier USSD screen gave up waiting) answer instantly; only the rest are checked.
    const cacheOn = settings.enabled && !opts.registry
    const strictDb = opts.strictDb ?? (supabase as unknown as SupabaseClient)
    // The switch read runs alongside the cache read: no extra sequential round trip.
    const [cached, strict] = await Promise.all([
      cacheOn ? getCachedVerdicts(phones, settings.providers) : Promise.resolve(new Map<string, boolean>()),
      settings.providers.length > 0 ? isStrictVerifyOn(strictDb) : Promise.resolve(false),
    ])
    const toCheck = [...new Set(phones)].filter(p => !cached.has(p))
    const answers: Array<{ phone: string; supplier: string; verdict: "yes" | "no" }> = []
    const fresh = await resolveVerdicts(toCheck, {
      onAnswer: strict ? (supplier, phone, verdict) => { answers.push({ phone, supplier, verdict }) } : undefined,
      settings: async () => settings,
      registry: opts.registry ?? WHITELIST_REGISTRY,
      check: (p, reg, s) => checkCustomerFacingVerification(p, reg, s),
      timeoutMs: opts.timeoutMs ?? (toCheck.length > 1 ? 10_000 : 5_000),
    })
    if (cacheOn) {
      const definite = new Map<string, boolean>()
      for (const [p, v] of fresh) if (v !== null) definite.set(p, v)
      await setCachedVerdicts(definite, settings.providers)
    }
    if (strict) {
      // The main-check answers are saved before returning (so an immediate send finds them), bounded to 1 s.
      await saveMainAnswersBounded(strictDb, answers)
      if (opts.strictBackground !== false) try {
        // Asking happens out of band; the task saves the answers again, including any that land after the race timeout.
        const ask = opts.ask ?? ((sup: string, p: string) => askSupplier(sup, p, { registry: opts.registry }))
        await runDeferred(opts.defer, () => strictBackground([...new Set(phones)], settings.providers, answers, strictDb, ask))
      } catch (err) {
        console.error("[CUSTOMER-VERIFICATION] strict recording failed:", errName(err))
      }
    }
    const verdicts = new Map<string, boolean | null>(phones.map(p => [p, cached.get(p) ?? fresh.get(p) ?? null]))
    const blocking = isBlockingOn(settings)
    const blocked = blocking ? [...new Set(phones)].filter(p => verdicts.get(p) === false) : []
    if (blocked.length > 0 && opts.context) {
      const contextSource = opts.context
      // Recording must never change the verdict or throw into the gate. A lazy
      // context is only resolved here, i.e. only when something was blocked.
      const task = async () => {
        try {
          const context = typeof contextSource === "function" ? await contextSource() : contextSource
          if (!context) return
          await recordBlockedRecipients(blocked, context, settings.providers)
        } catch (err) {
          console.error("[CUSTOMER-VERIFICATION] blocked-number record failed:", errName(err))
        }
      }
      try {
        await runDeferred(opts.defer, task)
      } catch (err) {
        console.error("[CUSTOMER-VERIFICATION] blocked-number record failed:", errName(err))
      }
    }
    return { verdicts, blocking, blocked }
  } catch {
    return { verdicts: new Map(phones.map(p => [p, null])), blocking: false, blocked: [] }
  }
}

/** Single-recipient convenience: true only for an MTN number the gate blocks. */
export async function isRecipientBlocked(
  network: string | null | undefined,
  phone: string,
  context?: BlockContext
): Promise<boolean> {
  if ((network ?? "").trim().toUpperCase() !== "MTN") return false
  return (await verifyRecipientsForOrder([phone], context ? { context } : {})).blocked.length > 0
}
