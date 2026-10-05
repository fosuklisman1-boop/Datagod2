// lib/ussd-hubtel/catalog.ts
import type { SupabaseClient } from "@supabase/supabase-js"

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

/** Mirrors the price verification in lib/ussd/handlers/bundles.ts handleConfirm. */
export function priceForTier(
  pkg: { price: number | string; dealer_price?: number | string | null },
  tier: string,
  catalogRow?: { parent_price: number | string; wholesale_margin: number | string } | null
): { price: number; parentProfit: number | null } {
  if (tier === "sub_agent") {
    return {
      price: catalogRow ? Number(catalogRow.parent_price) : Number(pkg.price),
      parentProfit: catalogRow ? Number(catalogRow.wholesale_margin) : null,
    }
  }
  const useDealer = tier === "dealer" && pkg.dealer_price && Number(pkg.dealer_price) > 0
  return { price: useDealer ? Number(pkg.dealer_price) : Number(pkg.price), parentProfit: null }
}

export async function resolveCaller(supabase: SupabaseClient, dialingPhone: string): Promise<CallerContext> {
  const local = dialingPhone.startsWith("+233") ? "0" + dialingPhone.slice(4) : dialingPhone
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
  const local = msisdn.startsWith("+233") ? "0" + msisdn.slice(4) : msisdn.startsWith("233") ? "0" + msisdn.slice(3) : msisdn
  const [{ data: setting }, { data: purchased }] = await Promise.all([
    supabase.from("admin_settings").select("value").eq("key", "ussd_data_whitelist_enabled").maybeSingle(),
    supabase.rpc("has_completed_purchase", { local_phone: local, msisdn }),
  ])
  return setting?.value?.enabled === true && purchased !== true
}
