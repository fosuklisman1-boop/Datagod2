import type { SupabaseClient } from "@supabase/supabase-js"

// Server-only: the package list (and selling prices) a public storefront shows.
// Moved verbatim out of app/api/shop/public-packages/route.ts so the
// storefront API and the server-rendered price table in
// app/shop/[slug]/page.tsx share ONE pricing code path: the server HTML and the
// interactive client (which reads the API) can never disagree.
//
// `exactPriceIds` lists the rows whose selling_price is computed exactly the way
// app/api/shop/orders/create/route.ts verifies it at order time:
//  - regular shops (shop_packages): base (dealer or retail) + profit_margin, same
//    as the order route.
//  - sub-agent rows from sub_agent_shop_packages WITH a stored parent_price: the
//    order route charges parent_price + sub_agent_profit_margin, same as here.
// Not exact (left out):
//  - sub_agent_shop_packages rows with no stored parent_price: here the parent
//    price is recomputed, but the order route reads the (null) column.
//  - the legacy sub_agent_catalog fallback: here the parent margin comes from the
//    PARENT shop's catalog and a null sub-agent margin falls back to
//    wholesale_margin; the order route uses the row's own wholesale_margin and
//    treats a null sub-agent margin as 0.

export interface PublicShopRef {
  id: string
  user_id: string
  parent_shop_id: string | null
}

export type PublicPackagesResult =
  | { ok: true; packages: any[]; exactPriceIds: Set<string> }
  | { ok: false; error: string }

export async function loadPublicShopPackages(
  supabase: SupabaseClient,
  shop: PublicShopRef,
): Promise<PublicPackagesResult> {
  const exactPriceIds = new Set<string>()

  // Fetch user role to check for dealer pricing
  const { data: userData } = await supabase
    .from("users")
    .select("role")
    .eq("id", shop.user_id)
    .single()
  const isDealer = userData?.role === 'dealer' || userData?.role === 'admin'

  let packages: any[] = []

  // Check if this is a sub-agent (has parent_shop_id)
  if (shop.parent_shop_id) {
    // Get parent shop owner's role
    const { data: parentShop } = await supabase
      .from("user_shops")
      .select("id, user_id")
      .eq("id", shop.parent_shop_id)
      .single();

    let isParentDealer = false;
    let parentMargins: Record<string, number> = {};
    if (parentShop) {
      const { data: parentUser } = await supabase
        .from("users")
        .select("role")
        .eq("id", parentShop.user_id)
        .single();
      isParentDealer = parentUser?.role === 'dealer' || parentUser?.role === 'admin';

      // Get parent's margins from their sub_agent_catalog
      const { data: parentCatalog } = await supabase
        .from("sub_agent_catalog")
        .select("package_id, wholesale_margin")
        .eq("shop_id", parentShop.id)
        .eq("is_active", true);

      if (parentCatalog) {
        parentMargins = parentCatalog.reduce((acc: any, item: any) => {
          acc[item.package_id] = item.wholesale_margin || 0;
          return acc;
        }, {});
      }
    }

    // Sub-agent: get packages from sub_agent_shop_packages table (their own inventory)
    // Fall back to sub_agent_catalog for backwards compatibility
    const { data: shopPkgs, error: shopPkgsError } = await supabase
      .from("sub_agent_shop_packages")
      .select(`
        id,
        package_id,
        parent_price,
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
      return { ok: false, error: "Failed to fetch packages" }
    }

    // If sub_agent_shop_packages table exists and has data, use it
    if (!shopPkgsError && shopPkgs && shopPkgs.length > 0) {
      // Transform catalog items using stored parent_price
      packages = shopPkgs
        .filter((item: any) => item.package?.is_available)
        .map((item: any) => {
          const pkgPrice = item.package.price || 0;
          const pkgDealerPrice = item.package.dealer_price;

          const adminPrice = (isParentDealer && pkgDealerPrice && pkgDealerPrice > 0)
            ? pkgDealerPrice
            : pkgPrice;

          const parentMargin = parentMargins[item.package_id] || 0;
          // Use stored parent_price if available (source of truth), otherwise calculate
          const hasStoredParentPrice = item.parent_price !== undefined && item.parent_price !== null
          const parentPrice = hasStoredParentPrice
            ? Number(item.parent_price)
            : (adminPrice + parentMargin);

          const subAgentMargin = item.sub_agent_profit_margin !== undefined && item.sub_agent_profit_margin !== null
            ? Number(item.sub_agent_profit_margin)
            : 0;
          const sellingPrice = parentPrice + subAgentMargin;

          if (hasStoredParentPrice) exactPriceIds.add(String(item.id))

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
            selling_price: sellingPrice
          }
        })
    } else {
      // Fall back to sub_agent_catalog for backwards compatibility
      const { data: catalogItems, error: catalogError } = await supabase
        .from("sub_agent_catalog")
        .select(`
          id,
          package_id,
          parent_price,
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
        return { ok: false, error: "Failed to fetch packages" }
      }

      // Transform using stored parent_price
      packages = (catalogItems || [])
        .filter((item: any) => item.package?.is_available)
        .map((item: any) => {
          const pkgPrice = item.package.price || 0;
          const pkgDealerPrice = item.package.dealer_price;

          const adminPrice = (isParentDealer && pkgDealerPrice && pkgDealerPrice > 0)
            ? pkgDealerPrice
            : pkgPrice;

          const parentMargin = parentMargins[item.package_id] || 0;
          const parentPrice = adminPrice + parentMargin;

          const subAgentMargin = item.sub_agent_profit_margin !== undefined && item.sub_agent_profit_margin !== null
            ? Number(item.sub_agent_profit_margin)
            : (item.wholesale_margin || 0);
          const sellingPrice = parentPrice + subAgentMargin;

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
            selling_price: sellingPrice
          }
        })
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
      return { ok: false, error: "Failed to fetch packages" }
    }

    // Filter out disabled admin packages
    packages = (shopPackages || [])
      .filter((item: any) => item.packages?.is_available !== false)
      .map((item: any) => {
        const basePrice = (isDealer && item.packages.dealer_price > 0)
          ? item.packages.dealer_price
          : item.packages.price;

        exactPriceIds.add(String(item.id))

        return {
          ...item,
          packages: {
            ...item.packages,
            price: basePrice
          },
          selling_price: basePrice + item.profit_margin
        }
      })
  }

  return { ok: true, packages, exactPriceIds }
}
