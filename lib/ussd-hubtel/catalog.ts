// lib/ussd-hubtel/catalog.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { effectivePrice, NO_CUSTOM_PRICES, type CustomPrices } from "@/lib/pricing/package-price"
import type { SubAgentOffer } from "@/lib/shop-commerce/pricing"

import { toLocalPhone } from "./protocol"

// Bundle listing is shared with the Uzo flow (pure DB read, no payment coupling).
export { fetchBundles, PAGE_SIZE } from "@/lib/ussd/handlers/bundles"

export interface CallerContext {
  effectivePriceTier: string
  subAgentParentShopId?: string
  userId?: string
}

/** Mirrors the tier logic inline in lib/ussd/handlers/bundles.ts handleSelectNetwork (minus wallet lookups). */
export function decideTier(
  defaultTier: string,
  role: string | undefined,
  parentShopId: string | null | undefined
): { tier: string; parentShopId?: string } {
  if (role === undefined) return { tier: defaultTier }
  if (role === "dealer") return { tier: "dealer" }
  if (role === "sub_agent" && parentShopId) return { tier: "sub_agent", parentShopId }
  return { tier: "regular" }
}

/**
 * Mirrors the price verification in lib/ussd/handlers/bundles.ts handleConfirm.
 * sub_agent tier: `offer` is the parent's live offer (subAgentCost): the price is the parent's role price + active
 * wholesale margin (the sub-agent's own custom prices never apply), and the parent earns wholesale margin + saving.
 * No offer (the parent does not offer the package) = null: refuse.
 */
export function priceForTier(
  pkg: { id?: string; price: number | string; dealer_price?: number | string | null },
  tier: string,
  offer?: Pick<SubAgentOffer, "cost" | "parentProfit"> | null,
  custom: CustomPrices = NO_CUSTOM_PRICES
): { price: number; parentProfit: number | null } | null {
  if (tier === "sub_agent") {
    return offer ? { price: offer.cost, parentProfit: offer.parentProfit } : null
  }
  return { price: effectivePrice({ ...pkg, id: pkg.id ?? "" }, tier === "dealer", custom), parentProfit: null }
}

export async function resolveCaller(supabase: SupabaseClient, dialingPhone: string): Promise<CallerContext> {
  const local = toLocalPhone(dialingPhone)
  const [{ data: userRow }, { data: settingsRow }] = await Promise.all([
    supabase.from("users").select("id, role").eq("phone_number", local).maybeSingle(),
    supabase.from("app_settings").select("ussd_price_tier").is("key", null).single(),
  ])
  const defaultTier = settingsRow?.ussd_price_tier ?? "regular"
  let parentShopId: string | null = null
  if (userRow?.role === "sub_agent") {
    const { data: shopRow } = await supabase
      .from("user_shops").select("parent_shop_id").eq("user_id", userRow.id).not("parent_shop_id", "is", null).maybeSingle()
    parentShopId = shopRow?.parent_shop_id ?? null
  }
  const { tier, parentShopId: parent } = decideTier(defaultTier, userRow?.role, parentShopId)
  return { effectivePriceTier: tier, subAgentParentShopId: parent, userId: userRow?.id }
}

/** Same whitelist gate the Uzo main menu applies at initiation. */
export async function isDataBlocked(supabase: SupabaseClient, msisdn: string): Promise<boolean> {
  const local = toLocalPhone(msisdn)
  const [{ data: setting }, { data: purchased }] = await Promise.all([
    supabase.from("admin_settings").select("value").eq("key", "ussd_data_whitelist_enabled").maybeSingle(),
    supabase.rpc("has_completed_purchase", { local_phone: local, msisdn }),
  ])
  return setting?.value?.enabled === true && purchased !== true
}
