import { createClient } from "@supabase/supabase-js"
import { ShopBundleOption } from "@/lib/ussd-shop/types"

// Channel-agnostic shop bundle pricing. Extracted verbatim from
// lib/ussd-shop/handlers/bundles.ts so both the USSD shop and the WhatsApp
// shop bot can share the exact same pricing/verification logic.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Using `typeof supabase` (rather than `ReturnType<typeof createClient>`) keeps the
// exact instantiated generic type — createClient's default type params don't survive
// ReturnType applied to the uninstantiated generic function.
type SupabaseClientLike = typeof supabase

export function sizeToMb(size: string): number {
  const m = size.trim().match(/(\d+(?:\.\d+)?)\s*(MB|GB|TB)/i)
  if (!m) {
    const n = parseFloat(size)
    return isNaN(n) ? 0 : n * 1024  // bare number treated as GB
  }
  const v = parseFloat(m[1])
  switch (m[2].toUpperCase()) {
    case 'MB': return v
    case 'GB': return v * 1024
    case 'TB': return v * 1024 * 1024
    default: return 0
  }
}

export async function shopOwnerIsDealer(
  shopId: string,
  client: SupabaseClientLike = supabase
): Promise<boolean> {
  // NOTE: user_shops.user_id references auth.users, not public.users, so a
  // PostgREST embed (users!inner(role)) resolves to auth.users.role
  // ('authenticated' for everyone) — never the app role. Look up the role
  // explicitly from public.users by id, matching the web storefront
  // (app/api/shop/public-packages/route.ts). Admins price like dealers too.
  const { data: shop } = await client
    .from("user_shops")
    .select("user_id")
    .eq("id", shopId)
    .single()
  if (!shop?.user_id) return false

  const { data: user } = await client
    .from("users")
    .select("role")
    .eq("id", shop.user_id)
    .single()
  return user?.role === 'dealer' || user?.role === 'admin'
}

export function basePrice(pkg: { price: number; dealer_price?: number | null }, isDealer: boolean): number {
  return isDealer && pkg.dealer_price && Number(pkg.dealer_price) > 0
    ? Number(pkg.dealer_price)
    : Number(pkg.price)
}

export async function fetchShopBundles(
  shopId: string,
  network: string,
  parentShopId?: string,
  client: SupabaseClientLike = supabase
): Promise<ShopBundleOption[]> {
  if (parentShopId) {
    const isDealer = await shopOwnerIsDealer(parentShopId, client)

    // New model: sub-agent has their own package list with parent_price already set
    const { data: sapRows } = await client
      .from("sub_agent_shop_packages")
      .select("package_id, parent_price, sub_agent_profit_margin")
      .eq("shop_id", shopId)
      .eq("is_active", true)

    if (sapRows?.length) {
      const { data: pkgRows } = await client
        .from("packages")
        .select("id, size")
        .in("id", sapRows.map(r => r.package_id))
        .eq("network", network)
        .eq("is_available", true)

      if (pkgRows?.length) {
        const sapMap = Object.fromEntries(sapRows.map(r => [r.package_id, r]))
        return pkgRows
          .map(pkg => ({
            id: pkg.id,
            size: pkg.size,
            price: Number(sapMap[pkg.id].parent_price) + Number(sapMap[pkg.id].sub_agent_profit_margin),
          }))
          .sort((a, b) => sizeToMb(a.size) - sizeToMb(b.size))
      }
    }

    // Old model fallback: use parent's sub_agent_catalog
    const { data: catalogRows } = await client
      .from("sub_agent_catalog")
      .select("package_id, wholesale_margin, sub_agent_profit_margin")
      .eq("shop_id", parentShopId)
      .eq("is_active", true)

    if (!catalogRows?.length) return []

    const { data: pkgRows } = await client
      .from("packages")
      .select("id, size, price, dealer_price")
      .in("id", catalogRows.map(r => r.package_id))
      .eq("network", network)
      .eq("is_available", true)

    if (!pkgRows?.length) return []

    const catMap = Object.fromEntries(catalogRows.map(r => [r.package_id, r]))
    return pkgRows
      .map(pkg => ({
        id: pkg.id,
        size: pkg.size,
        price: basePrice(pkg, isDealer) + Number(catMap[pkg.id].wholesale_margin) + Number(catMap[pkg.id].sub_agent_profit_margin),
      }))
      .sort((a, b) => sizeToMb(a.size) - sizeToMb(b.size))
  }

  const [spRows, isDealer] = await Promise.all([
    client
      .from("shop_packages")
      .select("package_id, profit_margin")
      .eq("shop_id", shopId)
      .eq("is_available", true)
      .then(r => r.data),
    shopOwnerIsDealer(shopId, client),
  ])

  if (!spRows?.length) return []

  const { data: pkgRows } = await client
    .from("packages")
    .select("id, size, price, dealer_price")
    .in("id", spRows.map(r => r.package_id))
    .eq("network", network)
    .eq("is_available", true)

  if (!pkgRows?.length) return []

  const profitMap = Object.fromEntries(spRows.map(r => [r.package_id, r.profit_margin]))
  return pkgRows
    .map(pkg => ({
      id: pkg.id,
      size: pkg.size,
      price: basePrice(pkg, isDealer) + Number(profitMap[pkg.id] ?? 0),
    }))
    .sort((a, b) => sizeToMb(a.size) - sizeToMb(b.size))
}

// Re-verifies a bundle's price at confirm/checkout time straight from the DB,
// mirroring the exact branches used by the USSD shop's handleConfirm — this
// prevents stale-session price manipulation regardless of which channel (USSD,
// WhatsApp, ...) initiated the order. Returns null when the package is no
// longer available (deactivated / removed from the shop's catalog).
export async function verifyBundlePrice(
  shopId: string,
  bundleId: string,
  parentShopId?: string,
  client: SupabaseClientLike = supabase
): Promise<{ verifiedPrice: number; profitAmount: number; parentProfitAmount: number } | null> {
  let verifiedPrice: number
  let profitAmount: number
  let parentProfitAmount = 0

  if (parentShopId) {
    const parentIsDealer = await shopOwnerIsDealer(parentShopId, client)

    // New model: sub_agent_shop_packages
    const { data: sapRow } = await client
      .from("sub_agent_shop_packages")
      .select("parent_price, sub_agent_profit_margin, packages!inner(price, dealer_price, is_available)")
      .eq("shop_id", shopId)
      .eq("package_id", bundleId)
      .eq("is_active", true)
      .maybeSingle()

    if (sapRow && (sapRow as any).packages?.is_available) {
      profitAmount = Number(sapRow.sub_agent_profit_margin)
      const bp = basePrice((sapRow as any).packages, parentIsDealer)
      parentProfitAmount = Math.max(0, Number(sapRow.parent_price) - bp)
      verifiedPrice = Number(sapRow.parent_price) + profitAmount
    } else {
      // Old model fallback: sub_agent_catalog
      const { data: catalogRow } = await client
        .from("sub_agent_catalog")
        .select("wholesale_margin, sub_agent_profit_margin, packages!inner(price, dealer_price, is_available)")
        .eq("shop_id", parentShopId)
        .eq("package_id", bundleId)
        .eq("is_active", true)
        .maybeSingle()

      if (!catalogRow || !(catalogRow as any).packages?.is_available) {
        return null
      }

      profitAmount = Number(catalogRow.sub_agent_profit_margin)
      parentProfitAmount = Number(catalogRow.wholesale_margin)
      verifiedPrice = basePrice((catalogRow as any).packages, parentIsDealer) + parentProfitAmount + profitAmount
    }
  } else {
    const [shopPkg, shopIsDealer] = await Promise.all([
      client
        .from("shop_packages")
        .select("profit_margin, packages!inner(price, dealer_price, is_available)")
        .eq("shop_id", shopId)
        .eq("package_id", bundleId)
        .eq("is_available", true)
        .maybeSingle()
        .then(r => r.data),
      shopOwnerIsDealer(shopId, client),
    ])

    if (!shopPkg || !(shopPkg as any).packages?.is_available) {
      return null
    }

    profitAmount = Number(shopPkg.profit_margin)
    verifiedPrice = basePrice((shopPkg as any).packages, shopIsDealer) + profitAmount
  }

  return { verifiedPrice, profitAmount, parentProfitAmount }
}
