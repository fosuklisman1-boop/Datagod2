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

import { supabaseAdmin as supabase } from "@/lib/supabase"
import { normalizePhoneNumber } from "@/lib/mtn-fulfillment"
import { WHITELIST_REGISTRY, type WhitelistEntry } from "./provider-whitelist"

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
 * Checks each phone against every admin-selected, registry-configured
 * provider — verified as soon as any one approves. Uses each provider's
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
  const resolvedSettings = settings ?? await getCustomerVerificationSettings()

  if (!resolvedSettings.enabled || resolvedSettings.providers.length === 0) {
    return phones.map(phone => ({ phone, verified: true }))
  }

  const configured = registry.filter(
    p => resolvedSettings.providers.includes(p.name) && p.configured()
  )
  if (configured.length === 0) {
    return phones.map(phone => ({ phone, verified: true }))
  }

  // Dedupe so a repeated phone in the input is only ever checked once against
  // the providers, no matter how many times it appears in `phones`.
  const uniquePhones = [...new Set(phones)]

  const verifiedSet = new Set<string>()
  let remaining = uniquePhones

  for (const provider of configured) {
    if (remaining.length === 0) break
    try {
      const batchResults = await provider.checkBatch(remaining)
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
        if (original) verifiedSet.add(original)
      }
      remaining = remaining.filter(p => !verifiedSet.has(p))
    } catch {
      // this provider's batch failure doesn't count as approval for anyone
      // still pending; move on to the next provider with the same remaining set
    }
  }

  return phones.map(phone => ({ phone, verified: verifiedSet.has(phone) }))
}

// ── Order-time verdicts + blocking ────────────────────────────────────────────

export const NOT_VERIFIED_MESSAGE =
  "This MTN number is not verified for data and can't be ordered. Please use a different number."
export const NOT_VERIFIED_CODE = "NUMBER_NOT_VERIFIED"

export function isBlockingOn(s: CustomerVerificationSettings): boolean {
  return s.enabled && s.block_unverified === true && s.providers.length > 0
}

export interface VerdictIo {
  settings(): Promise<CustomerVerificationSettings>
  registry: WhitelistEntry[]
  /** The shared guard (checkCustomerFacingVerification); receives the WRAPPED registry. */
  check(phones: string[], registry: WhitelistEntry[], settings: CustomerVerificationSettings): Promise<Array<{ phone: string; verified: boolean }>>
  timeoutMs: number
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
        const r = await p.checkBatch(msisdns)
        answered++
        return r
      },
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
  opts: { timeoutMs?: number; registry?: WhitelistEntry[]; settings?: CustomerVerificationSettings } = {}
): Promise<OrderVerification> {
  try {
    const settings = opts.settings ?? await getCustomerVerificationSettings()
    const verdicts = await resolveVerdicts(phones, {
      settings: async () => settings,
      registry: opts.registry ?? WHITELIST_REGISTRY,
      check: (p, reg, s) => checkCustomerFacingVerification(p, reg, s),
      timeoutMs: opts.timeoutMs ?? (phones.length > 1 ? 10_000 : 5_000),
    })
    const blocking = isBlockingOn(settings)
    const blocked = blocking ? [...new Set(phones)].filter(p => verdicts.get(p) === false) : []
    return { verdicts, blocking, blocked }
  } catch {
    return { verdicts: new Map(phones.map(p => [p, null])), blocking: false, blocked: [] }
  }
}

/** Single-recipient convenience: true only for an MTN number the gate blocks. */
export async function isRecipientBlocked(network: string | null | undefined, phone: string): Promise<boolean> {
  if ((network ?? "").trim().toUpperCase() !== "MTN") return false
  return (await verifyRecipientsForOrder([phone])).blocked.length > 0
}
