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
import { WHITELIST_REGISTRY, type WhitelistEntry } from "./provider-whitelist"

const SETTING_KEY = "customer_verification_settings"

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
 * provider in registry order — verified as soon as any one approves.
 * A provider whose check() throws simply doesn't count as an approval;
 * it never fails the batch.
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

  const results: Array<{ phone: string; verified: boolean }> = []
  for (const phone of phones) {
    let verified = false
    for (const provider of configured) {
      try {
        const result = await provider.check(phone)
        if (result.allowed) {
          verified = true
          break
        }
      } catch {
        // this provider's failure doesn't count as approval; try the next one
      }
    }
    results.push({ phone, verified })
  }
  return results
}
