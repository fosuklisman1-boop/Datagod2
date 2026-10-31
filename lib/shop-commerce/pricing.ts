import { createClient } from "@supabase/supabase-js"
import { ShopBundleOption } from "@/lib/ussd-shop/types"
import {
  CustomPriceReadError,
  customPricesForUser,
  effectivePrice,
  NO_CUSTOM_PRICES,
  ownerSaving,
  rolePrice,
  type CustomPrices,
} from "@/lib/pricing/package-price"

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

/**
 * The shop owner's pricing: dealer flag (dealer/admin, exactly as shopOwnerIsDealer) and custom prices.
 * Throws CustomPriceReadError when the owner's pricing mode or custom prices cannot be read.
 */
export async function shopOwnerPricing(
  shopId: string,
  client: SupabaseClientLike = supabase
): Promise<{ isDealer: boolean; custom: CustomPrices }> {
  // public.users by id, not a user_shops embed: see shopOwnerIsDealer.
  // maybeSingle: a missing row is not an error (default pricing, as before); a failed read is,
  // because then we cannot know whether a custom price applies, so refuse rather than drop the saving.
  const { data: shop, error: shopError } = await client
    .from("user_shops")
    .select("user_id")
    .eq("id", shopId)
    .maybeSingle()
  if (shopError) throw new CustomPriceReadError()
  if (!shop?.user_id) return { isDealer: false, custom: NO_CUSTOM_PRICES }

  const { data: user, error } = await client
    .from("users")
    .select("role, pricing_mode")
    .eq("id", shop.user_id)
    .maybeSingle()
  if (error) throw new CustomPriceReadError()
  const isDealer = user?.role === 'dealer' || user?.role === 'admin'
  // pricing_mode was selected, so a missing value means role mode (null), never "not loaded".
  const custom = await customPricesForUser(
    client,
    user ? { id: shop.user_id, pricing_mode: user.pricing_mode ?? null } : null
  )
  return { isDealer, custom }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Direct shop arithmetic (shared by verifyBundlePrice and the web storefront route).
 * The selling price stays role price + margin; the owner's profit is margin + saving, rounded, never clamped.
 */
export function directShopPricing({ rolePrice, margin, saving }: { rolePrice: number; margin: number; saving: number }): {
  basePrice: number
  totalPrice: number
  profit: number
} {
  return { basePrice: rolePrice, totalPrice: rolePrice + margin, profit: round2(margin + saving) }
}

/** Old-model (sub_agent_catalog) parent profit: wholesale margin + the parent's saving, rounded, never clamped. */
export function parentProfitFromCatalog(wholesale: number, saving: number): number {
  return round2(wholesale + saving)
}

/**
 * Every margin finite and >= 0. Negative margins are refused on every channel, so a negative profit can
 * only come from an owner's custom price above their role price (Datagod still receives role + margin).
 */
export function marginsValid(...margins: number[]): boolean {
  return margins.every(m => Number.isFinite(m) && m >= 0)
}

/**
 * Which wholesale margin applies to an old-model sub_agent_catalog row matched by the storefront.
 * A parent's own row: its wholesale_margin. A row keyed to the sub-agent's OWN shop (sub-agents can
 * write those through RLS): the parent's active row for the same package, as public-packages displays it
 * (parentMargins[package_id]); null when the parent has no such row (refuse).
 */
export function catalogWholesaleMargin(
  row: { shop_id: string; wholesale_margin: number | string | null | undefined },
  subAgentShopId: string,
  parentRow: { wholesale_margin: number | string | null | undefined } | null | undefined
): number | null {
  if (row.shop_id === subAgentShopId) {
    return parentRow ? Number(parentRow.wholesale_margin ?? 0) : null
  }
  return Number(row.wholesale_margin ?? 0)
}

export type OwnerPricing = { isDealer: boolean; custom: CustomPrices }

/** A package a parent offers their sub-agents, priced live. */
export type SubAgentOffer = {
  /** What the sub-agent pays: the parent's role price + the parent's ACTIVE wholesale margin. */
  cost: number
  wholesale: number
  /** What the parent is credited: wholesale margin + the parent's saving (custom price). */
  parentProfit: number
  pkg: { id: string; size: string; network: string; price: number | string; dealer_price: number | string | null }
}

/**
 * THE sub-agent cost rule (every sub-agent channel uses it). Per package id: the live offer, or null when the
 * parent has no active, available catalog row for it, or the margin is negative (not offered: hide and refuse).
 * Stored parent_price snapshots (sub_agent_catalog / sub_agent_shop_packages) are never read: they go stale when
 * a package price, the parent's role or the margin changes.
 *
 * packageIds null = every package the parent offers (optionally on one network).
 * Throws CustomPriceReadError when the catalog or the parent's pricing cannot be read.
 */
export async function subAgentCosts(
  parentShopId: string,
  packageIds: readonly string[] | null,
  client: SupabaseClientLike = supabase,
  opts: { network?: string } = {}
): Promise<{ parent: OwnerPricing; costs: Map<string, SubAgentOffer | null> }> {
  const wanted = packageIds ? new Set(packageIds.map(String)) : null

  const readCatalog = async (): Promise<any[]> => {
    if (wanted && wanted.size === 0) return []
    let q = client
      .from("sub_agent_catalog")
      .select("package_id, wholesale_margin, packages!inner(id, size, network, price, dealer_price, is_available)")
      .eq("shop_id", parentShopId)
      .eq("is_active", true)
      .eq("packages.is_available", true)
    if (opts.network) q = q.eq("packages.network", opts.network)
    if (wanted) q = q.in("package_id", [...wanted])
    let res: { data: unknown; error: unknown }
    try {
      res = await q.limit(1000)
    } catch {
      throw new CustomPriceReadError("Could not read the parent's sub-agent catalog")
    }
    if (res.error || !Array.isArray(res.data)) throw new CustomPriceReadError("Could not read the parent's sub-agent catalog")
    return res.data
  }

  const [parent, rows] = await Promise.all([shopOwnerPricing(parentShopId, client), readCatalog()])

  const costs = new Map<string, SubAgentOffer | null>()
  for (const row of rows) {
    const id = String(row.package_id)
    const pkg = Array.isArray(row.packages) ? row.packages[0] : row.packages
    if (!pkg || pkg.is_available === false) continue
    if (wanted && !wanted.has(id)) continue
    if (opts.network && pkg.network !== opts.network) continue
    const wholesale = Number(row.wholesale_margin ?? 0)
    if (!marginsValid(wholesale)) continue
    const priced = { ...pkg, id }
    costs.set(id, {
      cost: round2(rolePrice(priced, parent.isDealer) + wholesale),
      wholesale,
      parentProfit: parentProfitFromCatalog(wholesale, ownerSaving(priced, parent.isDealer, parent.custom)),
      pkg: { id, size: pkg.size, network: pkg.network, price: pkg.price, dealer_price: pkg.dealer_price ?? null },
    })
  }
  for (const id of wanted ?? []) if (!costs.has(id)) costs.set(id, null)
  return { parent, costs }
}

/** subAgentCosts for one package; null = not offered. Throws CustomPriceReadError like subAgentCosts. */
export async function subAgentCost(
  parentShopId: string,
  packageId: string,
  client: SupabaseClientLike = supabase
): Promise<SubAgentOffer | null> {
  const { costs } = await subAgentCosts(parentShopId, [String(packageId)], client)
  return costs.get(String(packageId)) ?? null
}

/**
 * The sub_agent tier menu (USSD, Hubtel, WhatsApp): the parent's offered packages on a network at live cost,
 * cheapest first, then by package id. Throws CustomPriceReadError like subAgentCosts.
 */
export async function subAgentBundles(
  parentShopId: string,
  network: string,
  client: SupabaseClientLike = supabase
): Promise<ShopBundleOption[]> {
  const { costs } = await subAgentCosts(parentShopId, null, client, { network })
  return [...costs.values()]
    .filter((o): o is SubAgentOffer => o !== null)
    .map(o => ({ id: o.pkg.id, size: String(o.pkg.size), price: o.cost }))
    .sort((a, b) => a.price - b.price || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** shopOwnerPricing, but null when custom prices cannot be read (the caller refuses). Other errors propagate. */
async function shopOwnerPricingOrNull(
  shopId: string,
  client: SupabaseClientLike
): Promise<{ isDealer: boolean; custom: CustomPrices } | null> {
  try {
    return await shopOwnerPricing(shopId, client)
  } catch (e) {
    if (e instanceof CustomPriceReadError) return null
    throw e
  }
}

export function basePrice(pkg: { price: number; dealer_price?: number | null }, isDealer: boolean): number {
  return rolePrice({ id: "", ...pkg }, isDealer)
}

export async function fetchShopBundles(
  shopId: string,
  network: string,
  parentShopId?: string,
  client: SupabaseClientLike = supabase
): Promise<ShopBundleOption[]> {
  if (parentShopId) {
    // Sub-agent prices are the parent's LIVE cost (subAgentCosts) + the sub-agent's margin. A package the
    // parent no longer offers is hidden. Display: a read failure lists nothing (confirm refuses anyway).
    let offers: Map<string, SubAgentOffer | null>
    const listed = (rows: Array<{ package_id: string; sub_agent_profit_margin: number | string | null }>) =>
      rows
        .map(r => ({ offer: offers.get(String(r.package_id)), margin: Number(r.sub_agent_profit_margin ?? 0) }))
        .filter((x): x is { offer: SubAgentOffer; margin: number } =>
          !!x.offer && x.offer.pkg.network === network && marginsValid(x.margin))
        .map(({ offer, margin }) => ({ id: offer.pkg.id, size: offer.pkg.size, price: round2(offer.cost + margin) }))
        .sort((a, b) => sizeToMb(a.size) - sizeToMb(b.size))

    // New model: sub-agent has their own package list (its stored parent_price is not trusted)
    const { data: sapRows } = await client
      .from("sub_agent_shop_packages")
      .select("package_id, sub_agent_profit_margin")
      .eq("shop_id", shopId)
      .eq("is_active", true)

    if (sapRows?.length) {
      try {
        offers = (await subAgentCosts(parentShopId, sapRows.map(r => String(r.package_id)), client)).costs
      } catch (e) {
        if (e instanceof CustomPriceReadError) return []
        throw e
      }
      const bundles = listed(sapRows)
      if (bundles.length) return bundles
    }

    // Old model fallback: use parent's sub_agent_catalog
    const { data: catalogRows } = await client
      .from("sub_agent_catalog")
      .select("package_id, sub_agent_profit_margin")
      .eq("shop_id", parentShopId)
      .eq("is_active", true)

    if (!catalogRows?.length) return []
    try {
      offers = (await subAgentCosts(parentShopId, catalogRows.map(r => String(r.package_id)), client)).costs
    } catch (e) {
      if (e instanceof CustomPriceReadError) return []
      throw e
    }
    return listed(catalogRows)
  }

  const [spRows, isDealer] = await Promise.all([
    client
      .from("shop_packages")
      .select("package_id, profit_margin")
      .eq("shop_id", shopId)
      .eq("is_available", true)
      // Ascending so a duplicate package's LATEST row wins in profitMap below,
      // matching verifyBundlePrice's pick.
      .order("updated_at", { ascending: true })
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
  // Selling prices stay role price + margin; an owner's custom price only raises that owner's profit.
  let verifiedPrice: number
  let profitAmount: number
  let parentProfitAmount = 0

  if (parentShopId) {
    // The parent's live cost and profit for this package (subAgentCosts). Not offered or unreadable: refuse.
    let offer: SubAgentOffer | null
    try {
      offer = await subAgentCost(parentShopId, bundleId, client)
    } catch (e) {
      if (e instanceof CustomPriceReadError) return null
      throw e
    }
    if (!offer) return null

    // New model: sub_agent_shop_packages (its stored parent_price is not trusted)
    const { data: sapRow } = await client
      .from("sub_agent_shop_packages")
      .select("sub_agent_profit_margin, packages!inner(id, is_available)")
      .eq("shop_id", shopId)
      .eq("package_id", bundleId)
      .eq("is_active", true)
      .maybeSingle()

    if (sapRow && (sapRow as any).packages?.is_available) {
      profitAmount = Number(sapRow.sub_agent_profit_margin)
    } else {
      // Old model fallback: the parent's sub_agent_catalog row carries the sub-agent margin
      const { data: catalogRow } = await client
        .from("sub_agent_catalog")
        .select("sub_agent_profit_margin, packages!inner(id, is_available)")
        .eq("shop_id", parentShopId)
        .eq("package_id", bundleId)
        .eq("is_active", true)
        .maybeSingle()

      if (!catalogRow || !(catalogRow as any).packages?.is_available) {
        return null
      }
      profitAmount = Number(catalogRow.sub_agent_profit_margin)
    }
    if (!marginsValid(profitAmount)) return null
    parentProfitAmount = offer.parentProfit
    verifiedPrice = round2(offer.cost + profitAmount)
  } else {
    const [shopPkg, owner] = await Promise.all([
      client
        .from("shop_packages")
        .select("profit_margin, packages!inner(id, price, dealer_price, is_available)")
        .eq("shop_id", shopId)
        .eq("package_id", bundleId)
        .eq("is_available", true)
        // shop_packages has no UNIQUE(shop_id, package_id): a package added twice
        // made a bare .maybeSingle() error (data null), so every confirm said
        // "no longer available". Take the latest row, the one fetchShopBundles prices with.
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(r => r.data),
      shopOwnerPricingOrNull(shopId, client),
    ])

    if (!owner) return null
    if (!shopPkg || !(shopPkg as any).packages?.is_available) {
      return null
    }

    const pkg = (shopPkg as any).packages
    const margin = Number(shopPkg.profit_margin)
    if (!marginsValid(margin)) return null
    const direct = directShopPricing({
      rolePrice: basePrice(pkg, owner.isDealer),
      margin,
      saving: ownerSaving(pkg, owner.isDealer, owner.custom),
    })
    profitAmount = direct.profit
    verifiedPrice = direct.totalPrice
  }

  return { verifiedPrice, profitAmount, parentProfitAmount }
}
