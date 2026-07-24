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
        if (provider === "sykes" || provider === "datakazina" || provider === "xpress" || provider === "eazyghdata" || provider === "bisdel" || provider === "codecraft" || provider === "agentportalgh") {
            return provider
        }

        // Default to Sykes if invalid or missing
        return "sykes"
    } catch (error) {
        console.error("[MTN-Factory] Error in getSelectedProvider:", error)
        return "sykes" // Default fallback
    }
}

/**
 * Get the MTN provider instance based on current settings
 * 
 * This is the main entry point for getting a provider.
 * It queries the admin_settings table to determine which provider to use.
 */
export async function getMTNProvider(): Promise<MTNProvider> {
    const providerName = await getSelectedProvider()

    console.log(`[MTN-Factory] Using provider: ${providerName}`)

    switch (providerName) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
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

const NON_MTN_CAPABLE: MTNProviderName[] = ["datakazina", "xpress", "eazyghdata", "codecraft"]

/**
 * Read the admin-selected provider for a non-MTN network (Telecel / AT-iShare / AT-BigTime).
 * Falls back to "codecraft" if the setting is absent or invalid.
 */
export async function getProviderNameForNetwork(normalizedNetwork: string): Promise<MTNProviderName> {
    const settingKey = NON_MTN_NETWORK_KEYS[normalizedNetwork]
    if (!settingKey) return "codecraft"

    try {
        const { data } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", settingKey)
            .maybeSingle()

        const name = data?.value?.provider as MTNProviderName | undefined
        if (name && NON_MTN_CAPABLE.includes(name)) return name
        return "codecraft"
    } catch {
        return "codecraft"
    }
}

const VALID_PROVIDERS: MTNProviderName[] = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh"]

/**
 * Get the configured retry sequence — an ordered list of provider names to try,
 * in order, when the primary provider fails (or a whitelist block prevents it
 * from being tried at all). Replaces the old single-fallback-provider setting.
 * The setting shape is { enabled: true, providers: ["eazyghdata", "bisdel"] }.
 * Returns [] if disabled, unset, or all entries are invalid provider names.
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
        return providers.filter((p: unknown): p is MTNProviderName =>
            VALID_PROVIDERS.includes(p as MTNProviderName)
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
