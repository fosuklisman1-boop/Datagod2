import type { SupabaseClient } from "@supabase/supabase-js"

export type AirtimeProvider = "digiwapy" | "hubtel" | "manual"
export const AIRTIME_PROVIDERS: readonly AirtimeProvider[] = ["digiwapy", "hubtel", "manual"]
export type AirtimeNetId = "mtn" | "telecel" | "at"
const NET_IDS: readonly AirtimeNetId[] = ["mtn", "telecel", "at"]

/** airtime_orders.network values are "MTN" | "Telecel" | "AT" (older rows may say AirtelTigo/Vodafone). */
export function airtimeNetId(network: string): AirtimeNetId | null {
  const n = network.trim().toLowerCase().replace(/[\s-]/g, "")
  if (n === "mtn") return "mtn"
  if (n === "telecel" || n === "vodafone") return "telecel"
  if (n === "at" || n === "airteltigo") return "at"
  return null
}

export const airtimeProviderKey = (id: AirtimeNetId) => `airtime_provider_${id}`
export const AIRTIME_PROVIDER_KEYS: string[] = NET_IDS.map(airtimeProviderKey)

export function parseAirtimeProvider(value: unknown): AirtimeProvider | null {
  const p = value && typeof value === "object" ? (value as any).provider : undefined
  return typeof p === "string" && (AIRTIME_PROVIDERS as readonly string[]).includes(p) ? (p as AirtimeProvider) : null
}

/**
 * Explicit per-network setting wins. With none (or an unreadable one) behaviour is exactly the
 * pre-Phase-2 path: the legacy airtime_digiwapy_enabled_<net> toggle decides Digiwapy vs manual.
 */
export async function getAirtimeProvider(
  db: SupabaseClient, network: string, legacyDigiwapyEnabled: (network: string) => Promise<boolean>,
): Promise<AirtimeProvider> {
  const id = airtimeNetId(network)
  if (!id) return "manual"
  try {
    const { data, error } = await db.from("admin_settings").select("value").eq("key", airtimeProviderKey(id)).maybeSingle()
    if (!error) {
      const explicit = parseAirtimeProvider(data?.value)
      if (explicit) return explicit
    } else {
      console.warn(`[AIRTIME-PROVIDER] read failed for ${id}, using legacy toggle:`, error.message ?? error)
    }
  } catch (e: any) {
    console.warn(`[AIRTIME-PROVIDER] read threw for ${id}, using legacy toggle:`, e?.message ?? e)
  }
  return (await legacyDigiwapyEnabled(network)) ? "digiwapy" : "manual"
}
