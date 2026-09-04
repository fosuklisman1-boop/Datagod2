/**
 * MTN Provider Factory
 * 
 * Selects and instantiates the appropriate MTN provider based on admin settings
 */

import { supabaseAdmin as supabase } from "@/lib/supabase"
import type { MTNProvider, MTNProviderName } from "./types"
import { SykesProvider } from "./sykes-provider"
import { DataKazinaProvider } from "./datakazina-provider"
import { XpressProvider } from "./xpress-provider"
import { EazyGhDataProvider } from "./eazyghdata-provider"
import { BisdelProvider } from "./bisdel-provider"
import { CodeCraftMTNProvider } from "./codecraft-provider"
import { AgentPortalGHProvider } from "./agentportalgh-provider"
import { ApexPrimeProvider } from "./apexprime-provider"

/**
 * Get the currently selected provider from database settings
 */
async function getSelectedProvider(): Promise<MTNProviderName> {
    try {
        const { data, error } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", "mtn_provider_selection")
            .maybeSingle()

        if (error) {
            console.warn("[MTN-Factory] Error fetching provider setting:", error)
            return "sykes" // Default fallback
        }

        const provider = data?.value?.provider as MTNProviderName | undefined

        // Validate provider name
        if (provider === "sykes" || provider === "datakazina" || provider === "xpress" || provider === "eazyghdata" || provider === "bisdel" || provider === "codecraft" || provider === "agentportalgh" || provider === "apexprime") {
            return provider
        }

        // Default to Sykes if invalid or missing
        return "sykes"
    } catch (error) {
        console.error("[MTN-Factory] Error in getSelectedProvider:", error)
        return "sykes" // Default fallback
    }
}

const VALID_PROVIDERS: MTNProviderName[] = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh", "apexprime"]

/**
 * Providers an admin has deactivated — excluded from automatic selection
 * (primary + retry sequence) everywhere. Does not affect explicit overrides
 * via getProviderByName() (manual admin retries, per-provider status checks).
 * Fails open (empty set) so a settings-read error never blocks fulfillment.
 */
export async function getDisabledProviders(): Promise<Set<MTNProviderName>> {
    try {
        const { data } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", "mtn_disabled_providers")
            .maybeSingle()

        const list = Array.isArray(data?.value?.providers) ? data.value.providers : []
        return new Set(list.filter((p: unknown): p is MTNProviderName => VALID_PROVIDERS.includes(p as MTNProviderName)))
    } catch {
        return new Set()
    }
}

/**
 * Get the MTN provider instance based on current settings
 *
 * This is the main entry point for getting a provider.
 * It queries the admin_settings table to determine which provider to use.
 * If the selected provider is deactivated, falls back to the first active
 * provider in VALID_PROVIDERS order.
 */
export async function getMTNProvider(): Promise<MTNProvider> {
    let providerName = await getSelectedProvider()

    const disabled = await getDisabledProviders()
    if (disabled.has(providerName)) {
        const fallback = VALID_PROVIDERS.find(p => !disabled.has(p))
        if (fallback) {
            console.warn(`[MTN-Factory] Selected provider "${providerName}" is deactivated — falling back to "${fallback}"`)
            providerName = fallback
        } else {
            console.error(`[MTN-Factory] All MTN providers are deactivated — using "${providerName}" anyway (fail open)`)
        }
    }

    console.log(`[MTN-Factory] Using provider: ${providerName}`)

    switch (providerName) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
        case "bisdel":
            return new BisdelProvider()
        case "codecraft":
            return new CodeCraftMTNProvider()
        case "datakazina":
            return new DataKazinaProvider()
        case "xpress":
            return new XpressProvider()
        case "eazyghdata":
            return new EazyGhDataProvider()
        case "sykes":
        default:
            return new SykesProvider()
    }
}

// Networks whose fulfillment provider is configurable separately from MTN
const NON_MTN_NETWORK_KEYS: Record<string, string> = {
    "TELECEL": "telecel_provider_selection",
    "AIRTELTIGO": "telecel_provider_selection",
    "AT - ISHARE": "at_ishare_provider_selection",
    "AT-ISHARE": "at_ishare_provider_selection",
    "AT - BIGTIME": "at_bigtime_provider_selection",
    "AT-BIGTIME": "at_bigtime_provider_selection",
}

// Network name normalised to the MTNOrderRequest.network union value
export const NETWORK_TO_REQUEST_NETWORK: Record<string, "Telecel" | "AirtelTigo"> = {
    "TELECEL": "Telecel",
    "AIRTELTIGO": "AirtelTigo",
    "AT - ISHARE": "AirtelTigo",
    "AT-ISHARE": "AirtelTigo",
    "AT - BIGTIME": "AirtelTigo",
    "AT-BIGTIME": "AirtelTigo",
}

export const NON_MTN_CAPABLE: Record<string, MTNProviderName[]> = {
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
    at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
    at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}

/** Is `provider` a valid, capability-checked choice for this non-MTN network? */
export function isProviderCapableForNetwork(normalizedNetwork: string, provider: MTNProviderName): boolean {
    const settingKey = NON_MTN_NETWORK_KEYS[normalizedNetwork]
    if (!settingKey) return false
    return (NON_MTN_CAPABLE[settingKey] ?? []).includes(provider)
}

/**
 * Read the admin-selected provider for a non-MTN network (Telecel / AT-iShare / AT-BigTime).
 * Falls back to "codecraft" if the setting is absent or invalid.
 *
 * Deliberately does NOT consult mtn_disabled_providers here. It used to: if the
 * selected provider was deactivated, it walked NON_MTN_CAPABLE[settingKey] in
 * fixed array order and used the first non-disabled entry. That "fallback" was
 * never an admin choice — it just meant whichever provider happened to be
 * first in the array (datakazina) silently absorbed orders the admin never
 * routed to it, with no visible link between "I disabled agentportalgh" and
 * "my Telecel orders are now going to datakazina" (root-caused 2026-09-01).
 * Unlike MTN (which has an explicit, admin-configured mtn_retry_sequence for
 * intentional fallback ordering), there is no equivalent ordered-preference
 * setting for non-MTN — so there is no safe substitute to guess. The per-
 * network selection is the admin's explicit, direct choice for exactly this
 * network; honor it always. If they want a provider never used for a given
 * network, the correct control is changing telecel_provider_selection /
 * at_ishare_provider_selection / at_bigtime_provider_selection directly, not
 * the global deactivation toggle (which still governs MTN selection and the
 * MTN retry sequence, per its own scope — see project-mtn-provider-deactivation
 * memory for the documented "excludes from ... non-MTN routing" claim this
 * fix intentionally supersedes).
 */
export async function getProviderNameForNetwork(normalizedNetwork: string): Promise<MTNProviderName> {
    const settingKey = NON_MTN_NETWORK_KEYS[normalizedNetwork]
    if (!settingKey) return "codecraft"

    const capable = NON_MTN_CAPABLE[settingKey] ?? ["codecraft"]

    try {
        const { data } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", settingKey)
            .maybeSingle()

        const name = data?.value?.provider as MTNProviderName | undefined
        return name && capable.includes(name) ? name : "codecraft"
    } catch {
        return "codecraft"
    }
}

/**
 * Get the configured retry sequence — an ordered list of provider names to try,
 * in order, when the primary provider fails (or a whitelist block prevents it
 * from being tried at all). Replaces the old single-fallback-provider setting.
 * The setting shape is { enabled: true, providers: ["eazyghdata", "bisdel"] }.
 * Returns [] if disabled, unset, or all entries are invalid/deactivated provider names.
 */
export async function getRetrySequence(): Promise<MTNProviderName[]> {
    try {
        const { data } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", "mtn_retry_sequence")
            .maybeSingle()

        const value = data?.value
        if (!value?.enabled) return []
        const providers = Array.isArray(value?.providers) ? value.providers : []
        const disabled = await getDisabledProviders()
        return providers.filter((p: unknown): p is MTNProviderName =>
            VALID_PROVIDERS.includes(p as MTNProviderName) && !disabled.has(p as MTNProviderName)
        )
    } catch {
        return []
    }
}

/**
 * Get a specific provider by name (for testing or manual override)
 */
export function getProviderByName(name: MTNProviderName): MTNProvider {
    switch (name) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
        case "bisdel":
            return new BisdelProvider()
        case "codecraft":
            return new CodeCraftMTNProvider()
        case "datakazina":
            return new DataKazinaProvider()
        case "xpress":
            return new XpressProvider()
        case "eazyghdata":
            return new EazyGhDataProvider()
        case "sykes":
            return new SykesProvider()
    }
}
