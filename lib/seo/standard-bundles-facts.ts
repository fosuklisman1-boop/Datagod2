/**
 * Whether the dashboard "Standard Bundles" (lib/standard-bundles) currently
 * sell Telecel with the "No Expiry" category visible, for the
 * /non-expiry-data-bundles landing page.
 *
 * Standard Bundles are a separate product from the public `packages` price
 * tables: logged-in customers buy them at /dashboard/standard-bundles from the
 * network's own catalogue (fetched live from Hubtel per request, so there are
 * no public prices to show). lib/standard-bundles/categories.ts groups Telecel
 * bundles whose name starts "No Expiry" into a "No Expiry" category. The
 * landing page only mentions it while this returns true.
 *
 * Same gate as getBundlesAvailability (lib/standard-bundles/runtime.ts):
 * bundles master switch + Telecel switch, Hubtel on and its data_telecel
 * service on; plus the admin has not hidden the "No Expiry" category and
 * Hubtel is not paused (a paused service cannot sell right now).
 *
 * Fails closed: any read error means "do not mention it". Cached for an hour
 * under the "seo-live-facts" tag; an error is thrown out of the cached
 * function so it is never cached.
 */
import { cache } from "react"
import { unstable_cache } from "next/cache"
import { unstable_rethrow } from "next/navigation"
import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { getBundlesConfig, type BundlesConfig } from "@/lib/standard-bundles/config"
import { getHubtelCsConfig, type HubtelCsConfig } from "@/lib/hubtel-cs/config"
import { NETWORK_SERVICE } from "@/lib/standard-bundles/categories"

export const NO_EXPIRY_CATEGORY = "No Expiry"

/** Pure: the gate described above. */
export function telecelNoExpiryOffered(
  bundles: Pick<BundlesConfig, "enabled" | "networks">,
  hubtel: Pick<HubtelCsConfig, "enabled" | "paused" | "services">,
): boolean {
  const net = bundles.networks?.TELECEL
  return (
    bundles.enabled === true &&
    net?.enabled === true &&
    !(net.hiddenCategories ?? []).includes(NO_EXPIRY_CATEGORY) &&
    hubtel.enabled === true &&
    hubtel.paused !== true &&
    hubtel.services?.[NETWORK_SERVICE.TELECEL] === true
  )
}

async function load(): Promise<boolean> {
  const db = supabaseAdmin as SupabaseClient
  const [bundles, hubtel] = await Promise.all([getBundlesConfig(db), getHubtelCsConfig(db)])
  return telecelNoExpiryOffered(bundles, hubtel)
}

const cached = unstable_cache(load, ["seo-standard-no-expiry", "v1"], { revalidate: 3600, tags: ["seo-live-facts"] })

/** One read per request; false on any error (never cached). */
export const getStandardNoExpiry = cache(async (): Promise<boolean> => {
  try {
    return await cached()
  } catch (e) {
    // Never swallow Next's own control-flow errors (dynamic bailout, notFound, ...).
    unstable_rethrow(e)
    const msg = e instanceof Error ? e.message : (e as { message?: unknown } | null)?.message
    console.error("[seo-standard-no-expiry] read failed:", typeof msg === "string" ? msg : "unknown error")
    return false
  }
})
