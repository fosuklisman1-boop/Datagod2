/**
 * MTN Provider Factory
 * 
 * Selects and instantiates the appropriate MTN provider based on admin settings
 */

import { supabaseAdmin as supabase } from "@/lib/supabase"
import type { MTNProvider, MTNProviderName } from "./types"
import { SykesProvider } from "./sykes-provider"
import { DataKazinaProvider } from "./datakazina-provider"

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
        if (provider === "sykes" || provider === "datakazina") {
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
        case "datakazina":
            return new DataKazinaProvider()
        case "sykes":
        default:
            return new SykesProvider()
    }
}

/**
 * Get a specific provider by name (for testing or manual override)
 */
export function getProviderByName(name: MTNProviderName): MTNProvider {
    switch (name) {
        case "datakazina":
            return new DataKazinaProvider()
        case "sykes":
            return new SykesProvider()
    }
}
