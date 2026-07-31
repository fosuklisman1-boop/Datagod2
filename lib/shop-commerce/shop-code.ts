import { createClient } from "@supabase/supabase-js"

// Channel-agnostic shop-code resolver. Extracted from the lookup portion of
// lib/ussd-shop/handlers/shop.ts's handleEnterShopCode, so both the USSD shop
// and the WhatsApp shop bot can share the exact same "what does this code
// mean" logic. Deliberately does NOT deduct tokens, build network lists, or
// write session state — those stay channel-specific and live in the callers.
// It also does NOT gate on status/token balance/activation — it just resolves
// and reports the facts; the caller decides whether the code is "usable".

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Using `typeof supabase` (rather than `ReturnType<typeof createClient>`) keeps the
// exact instantiated generic type — createClient's default type params don't survive
// ReturnType applied to the uninstantiated generic function.
type SupabaseClientLike = typeof supabase

export interface ResolvedShopCode {
  shopCodeId: string
  shopId: string
  shopName: string
  parentShopId: string | null
  status: string
  tokenBalance: number
  whatsappActivated: boolean
}

export async function resolveShopCode(
  code: string,
  client: SupabaseClientLike = supabase
): Promise<ResolvedShopCode | null> {
  const { data: shopCode, error } = await client
    .from("ussd_shop_codes")
    .select("id, shop_id, status, token_balance, whatsapp_activated")
    .eq("code", code.trim())
    .maybeSingle()

  if (error) console.error("resolveShopCode: ussd_shop_codes query failed", error)
  if (!shopCode) return null

  const { data: shopRow } = await client
    .from("user_shops")
    .select("shop_name, parent_shop_id")
    .eq("id", shopCode.shop_id)
    .single()

  return {
    shopCodeId: shopCode.id,
    shopId: shopCode.shop_id,
    shopName: shopRow?.shop_name ?? 'Shop',
    parentShopId: (shopRow as any)?.parent_shop_id ?? null,
    status: shopCode.status,
    tokenBalance: shopCode.token_balance,
    whatsappActivated: shopCode.whatsapp_activated === true,
  }
}

// Distinct, deduped list of networks a shop's Data Bundle catalog currently offers.
// Extracted from the network-listing block inside lib/ussd-shop/handlers/shop.ts's
// handleEnterShopCode (the USSD entry handler) so the WhatsApp shop bot can build the
// same list without duplicating the sub-agent/regular-shop branching. Deliberately
// returns an UNSORTED, deduped list — display ordering (sortNetworks) stays a
// presentation concern for the caller (see lib/ussd-shop/menus.ts /
// lib/whatsapp-bot/shop-menus.ts), matching how resolveShopCode above also just
// resolves facts without deciding how they're shown.
export async function fetchShopNetworks(
  shopId: string,
  parentShopId?: string | null,
  client: SupabaseClientLike = supabase
): Promise<string[]> {
  const networks: string[] = []
  const seen = new Set<string>()

  if (parentShopId) {
    // New model: sub-agent's own package list
    const { data: sapRows } = await client
      .from("sub_agent_shop_packages")
      .select("package_id")
      .eq("shop_id", shopId)
      .eq("is_active", true)

    const packageIds: string[] = sapRows?.length
      ? sapRows.map((r: any) => r.package_id)
      : await client
          .from("sub_agent_catalog")
          .select("package_id")
          .eq("shop_id", parentShopId)
          .eq("is_active", true)
          .then((r: any) => r.data?.map((row: any) => row.package_id) ?? [])

    if (packageIds.length) {
      const { data: pkgRows } = await client
        .from("packages")
        .select("network")
        .in("id", packageIds)
        .eq("is_available", true)

      for (const pkg of pkgRows ?? []) {
        if (pkg.network && !seen.has(pkg.network)) { seen.add(pkg.network); networks.push(pkg.network) }
      }
    }
    return networks
  }

  const { data: spRows } = await client
    .from("shop_packages")
    .select("package_id")
    .eq("shop_id", shopId)
    .eq("is_available", true)

  if (spRows?.length) {
    const { data: pkgRows } = await client
      .from("packages")
      .select("network")
      .in("id", spRows.map((r: any) => r.package_id))
      .eq("is_available", true)

    for (const pkg of pkgRows ?? []) {
      if (pkg.network && !seen.has(pkg.network)) { seen.add(pkg.network); networks.push(pkg.network) }
    }
  }
  return networks
}
