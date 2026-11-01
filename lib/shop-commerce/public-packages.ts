import type { SupabaseClient } from "@supabase/supabase-js"
import { CustomPriceReadError, MSG_PRICES_UNAVAILABLE, rolePrice } from "@/lib/pricing/package-price"
import { catalogSubAgentMargin, marginsValid, subAgentCosts } from "./pricing"

// Server-only: the package list (and selling prices) a public storefront shows.
// Moved out of app/api/shop/public-packages/route.ts so the storefront API and
// the server-rendered price table in app/shop/[slug]/page.tsx share ONE pricing
// code path: the server HTML and the interactive client (which reads the API)
// can never disagree. The pricing is main's (#27, live sub-agent pricing).
//
// `exactPriceIds` lists the rows whose selling_price equals what
// app/api/shop/orders/create/route.ts charges for that row (shop_package_id = row id):
//  - sub-agent rows (sub_agent_shop_packages, and old-model sub_agent_catalog rows
//    keyed to the sub-agent's own shop): both sides take the cost from the same
//    live helper (subAgentCosts: the parent's role price + the parent's ACTIVE
//    wholesale margin), the same sub-agent margin (Number(sub_agent_profit_margin || 0),
//    or catalogSubAgentMargin for catalog rows), refuse negative margins and
//    packages the parent no longer offers, and round the sum to 2 dp. Rows that
//    would be refused are not listed at all, so every listed sub-agent row is exact.
//  - regular shops (shop_packages): the order route charges rolePrice(owner role) +
//    Number(profit_margin || 0) and refuses a negative margin; a row is exact only
//    when that recomputation equals the listed selling_price, the margin is valid,
//    and the owner's role was actually read (a failed read lists retail prices,
//    while the order route would charge the dealer price or refuse).

export interface PublicShopRef {
  id: string
  user_id: string
  parent_shop_id: string | null
}

export type PublicPackagesResult =
  | { ok: true; packages: any[]; exactPriceIds: Set<string> }
  | { ok: false; status: 500 | 503; error: string }

const round2 = (n: number) => Math.round(n * 100) / 100

export async function loadPublicShopPackages(
  supabase: SupabaseClient,
  shop: PublicShopRef,
): Promise<PublicPackagesResult> {
  const exactPriceIds = new Set<string>()

  // Fetch user role to check for dealer pricing
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("role")
    .eq("id", shop.user_id)
    .single()
  const isDealer = userData?.role === 'dealer' || userData?.role === 'admin'
  // No row (PGRST116) prices at retail on both sides; any other read failure is unknown.
  const roleKnown = !userError || userError.code === 'PGRST116'

  let packages: any[] = []

  // Check if this is a sub-agent (has parent_shop_id)
  if (shop.parent_shop_id) {
    const parentShopId = shop.parent_shop_id
    // Sub-agent prices: the parent's LIVE cost (subAgentCosts: parent role price + the parent's active
    // wholesale margin) + the sub-agent's margin, exactly what app/api/shop/orders/create charges. Stored
    // parent_price snapshots are not trusted. Packages the parent no longer offers are hidden.
    const priceRows = async (rows: any[], subMarginOf: (item: any) => number) => {
      const { costs } = await subAgentCosts(
        parentShopId,
        rows.map((item: any) => String(item.package_id)),
        supabase as Parameters<typeof subAgentCosts>[2]
      )
      return rows
        .filter((item: any) => item.package?.is_available)
        .map((item: any) => ({ item, offer: costs.get(String(item.package_id)), subAgentMargin: subMarginOf(item) }))
        .filter(({ offer, subAgentMargin }) => !!offer && marginsValid(subAgentMargin))
        .map(({ item, offer, subAgentMargin }) => {
          const parentPrice = offer!.cost
          exactPriceIds.add(String(item.id))
          return {
            id: item.id,
            package_id: item.package.id,
            profit_margin: subAgentMargin,
            parent_price: parentPrice,
            is_available: item.is_active,
            packages: {
              id: item.package.id,
              network: item.package.network,
              size: item.package.size,
              price: parentPrice,
              description: item.package.description
            },
            selling_price: round2(parentPrice + subAgentMargin)
          }
        })
    }

    // Sub-agent: get packages from sub_agent_shop_packages table (their own inventory)
    // Fall back to sub_agent_catalog for backwards compatibility
    const { data: shopPkgs, error: shopPkgsError } = await supabase
      .from("sub_agent_shop_packages")
      .select(`
        id,
        package_id,
        sub_agent_profit_margin,
        is_active,
        package:packages (
          id,
          network,
          size,
          price,
          dealer_price,
          description,
          is_available
        )
      `)
      .eq("shop_id", shop.id)
      .eq("is_active", true)

    if (shopPkgsError && shopPkgsError.code !== 'PGRST116') {
      // If not "relation does not exist", it's a real error
      console.error("Error fetching sub-agent shop packages:", shopPkgsError)
      return { ok: false, status: 500, error: "Failed to fetch packages" }
    }

    try {
      // If sub_agent_shop_packages table exists and has data, use it
      if (!shopPkgsError && shopPkgs && shopPkgs.length > 0) {
        packages = await priceRows(shopPkgs, (item: any) => Number(item.sub_agent_profit_margin || 0))
      } else {
        // Fall back to sub_agent_catalog for backwards compatibility
        const { data: catalogItems, error: catalogError } = await supabase
          .from("sub_agent_catalog")
          .select(`
            id,
            package_id,
            shop_id,
            sub_agent_profit_margin,
            wholesale_margin,
            is_active,
            package:packages (
              id,
              network,
              size,
              price,
              dealer_price,
              description,
              is_available
            )
          `)
          .eq("shop_id", shop.id)
          .eq("is_active", true)

        if (catalogError) {
          console.error("Error fetching sub-agent catalog:", catalogError)
          return { ok: false, status: 500, error: "Failed to fetch packages" }
        }

        // Own-shop rows: the cost uses the PARENT's active row (an own-shop wholesale_margin is never used),
        // and the sub-agent margin as the order route reads it (legacy rows keep it in wholesale_margin).
        packages = await priceRows(catalogItems || [], (item: any) => catalogSubAgentMargin(item, shop.id))
      }
    } catch (e) {
      if (!(e instanceof CustomPriceReadError)) throw e
      console.error("[PUBLIC-API] Could not read the parent's catalog or pricing")
      return { ok: false, status: 503, error: MSG_PRICES_UNAVAILABLE }
    }

  } else {
    // Regular shop owner: get packages from shop_packages
    const { data: shopPackages, error: pkgError } = await supabase
      .from("shop_packages")
      .select(`
        id,
        package_id,
        profit_margin,
        is_available,
        custom_name,
        packages (
          id,
          network,
          size,
          price,
          dealer_price,
          description,
          is_available
        )
      `)
      .eq("shop_id", shop.id)
      .eq("is_available", true)

    if (pkgError) {
      console.error("Error fetching shop packages:", pkgError)
      return { ok: false, status: 500, error: "Failed to fetch packages" }
    }

    // Filter out disabled admin packages
    packages = (shopPackages || [])
      .filter((item: any) => item.packages?.is_available !== false)
      .map((item: any) => {
        const basePrice = (isDealer && item.packages.dealer_price > 0)
          ? item.packages.dealer_price
          : item.packages.price;
        const sellingPrice = basePrice + item.profit_margin

        // What the order route charges for this row: rolePrice + margin (negative margins refused).
        const margin = Number(item.profit_margin || 0)
        if (roleKnown && item.packages && marginsValid(margin)) {
          const charged = rolePrice(item.packages, isDealer) + margin
          if (Math.abs(Number(sellingPrice) - charged) < 0.005) exactPriceIds.add(String(item.id))
        }

        return {
          ...item,
          packages: {
            ...item.packages,
            price: basePrice
          },
          selling_price: sellingPrice
        }
      })
  }

  return { ok: true, packages, exactPriceIds }
}
