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
}

const DEFAULT_SETTINGS: CustomerVerificationSettings = { enabled: false, providers: [] }

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
    return { enabled: value.enabled, providers: value.providers }
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
