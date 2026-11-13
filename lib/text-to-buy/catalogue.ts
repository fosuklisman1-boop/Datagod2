// Text-to-Buy catalogue: which package a text order buys, at what price, and the in-memory USSD session the existing
// confirm handler (handleConfirm) needs to charge it.
//
// PRICE RULE: a price here is only ever a value fetchAllBundles returned (the same query and pricing code as the USSD
// bundle menu: effectivePrice / getCustomPrices / subAgentBundles), for the SENDER's buyer tier. Nothing the customer
// typed, and nothing an AI read, can reach it. handleConfirm re-prices from the database again before any charge.

import type { SupabaseClient } from "@supabase/supabase-js"
import { fetchAllBundles } from "@/lib/ussd/handlers/bundles"
import { resolveBuyerTier, type BuyerTier } from "@/lib/ussd/buyer-tier"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import type { USSDSession } from "@/lib/ussd/types"
import { detectNetworkWithMap, ghanaSignificant, normalizeGhanaPhone, type GhanaNetwork } from "@/lib/phone-format"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { isRecipientBlocked } from "@/lib/mtn-providers/customer-verification"
import { getUssdServiceVisibility } from "@/lib/ussd-service-visibility"
import type { NetworkHint } from "./types"

type Product = "MTN" | "Telecel" | "AT-iShare" | "AT-BigTime"
type Label = "MTN" | "Telecel" | "AT"
type Provider = "mtn" | "vod" | "tgo"

export type Offer = {
  network: Product
  networkLabel: Label
  bundleId: string
  /** The stored packages.size, verbatim: handleConfirm writes it to the order. Use sizeLabel() for text. */
  size: string
  price: number
  recipientLocal: string
  gift: boolean
  tier: BuyerTier
  paystackProvider: Provider
}

export type OfferResult =
  | { ok: true; offer: Offer }
  | { ok: false; reason: "choose_product"; options: Offer[] }
  | { ok: false; reason: "no_package"; networkLabel: string; nearest: { size: string; priceGhs: number }[] }
  | { ok: false; reason: "need_recipient"; networkLabel: string }
  | { ok: false; reason: "bad_recipient" }
  | { ok: false; reason: "service_off" }
  | { ok: false; reason: "prices_unavailable" }

const PRODUCT_LABEL: Record<Product, Label> = { MTN: "MTN", Telecel: "Telecel", "AT-iShare": "AT", "AT-BigTime": "AT" }
const PRODUCT_PROVIDER: Record<Product, Provider> = { MTN: "mtn", Telecel: "vod", "AT-iShare": "tgo", "AT-BigTime": "tgo" }
const CARRIER_PRODUCTS: Record<Exclude<GhanaNetwork, "UNKNOWN">, Product[]> = {
  MTN: ["MTN"],
  TELECEL: ["Telecel"],
  AT: ["AT-iShare", "AT-BigTime"],
}
const CARRIER_LABEL: Record<Exclude<GhanaNetwork, "UNKNOWN">, Label> = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" }
const HINT_CARRIER: Record<NetworkHint, Exclude<GhanaNetwork, "UNKNOWN">> = {
  MTN: "MTN", Telecel: "TELECEL", AT: "AT", "AT-iShare": "AT", "AT-BigTime": "AT",
}

// A stored size is a number with an optional GB/MB unit. No unit means GB (the platform stores "1", "2", ...), and
// 1000 MB = 1 GB, the same convention as lib/seo/data-prices.ts. Anything else ("Unlimited", "3GB MTN", "") is not
// orderable by text.
const SIZE_RE = /^\s*(\d+(?:\.\d+)?)\s*(gb|mb)?\s*$/i

function parseSize(size: string): { n: number; unit: "GB" | "MB" } | null {
  const m = SIZE_RE.exec(String(size ?? ""))
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return { n, unit: m[2]?.toLowerCase() === "mb" ? "MB" : "GB" }
}

export function parseSizeMb(size: string): number | null {
  const p = parseSize(size)
  return p ? Math.round(p.unit === "GB" ? p.n * 1000 : p.n) : null
}

/** "5" / "5 GB" / "5gb" -> "5GB"; "500 MB" -> "500MB". For SMS text only; never stored. */
export function sizeLabel(size: string): string {
  const p = parseSize(size)
  return p ? `${p.n}${p.unit}` : size
}

/** Section of the catalogue one product offers for the buyer, parsed and priced. Throws when a price cannot be read. */
async function productPackages(product: Product, tier: BuyerTier) {
  const all = await fetchAllBundles(product, tier.effectivePriceTier, tier.subAgentParentShopId, tier.userId)
  const out: { id: string; size: string; mb: number; price: number }[] = []
  for (const b of all) {
    const mb = parseSizeMb(b.size)
    const price = Number(b.price)
    if (mb === null || !Number.isFinite(price) || price <= 0) continue
    out.push({ id: String(b.id), size: b.size, mb, price })
  }
  return out
}

export async function resolveOffer(
  supabase: SupabaseClient,
  i: { senderLocal: string; sizeMb: number; networkHint: NetworkHint | null; recipient: string | null }
): Promise<OfferResult> {
  let visibility
  try {
    visibility = await getUssdServiceVisibility(supabase)
  } catch {
    return { ok: false, reason: "prices_unavailable" }
  }
  if (!visibility.data) return { ok: false, reason: "service_off" }

  const recipientLocal = i.recipient === null ? i.senderLocal : normalizeGhanaPhone(i.recipient)
  if (!recipientLocal) return { ok: false, reason: "bad_recipient" }
  const gift = recipientLocal !== i.senderLocal

  // The recipient's carrier (admin prefix map) decides the network.
  const { map } = await getPrefixValidationConfig()
  const carrier = detectNetworkWithMap(recipientLocal, map)
  if (carrier === "UNKNOWN") return { ok: false, reason: "bad_recipient" }

  if (i.networkHint && HINT_CARRIER[i.networkHint] !== carrier) {
    return i.recipient === null
      ? { ok: false, reason: "need_recipient", networkLabel: CARRIER_LABEL[HINT_CARRIER[i.networkHint]] }
      : { ok: false, reason: "bad_recipient" }
  }

  const products =
    i.networkHint === "AT-iShare" || i.networkHint === "AT-BigTime" ? [i.networkHint as Product] : CARRIER_PRODUCTS[carrier]
  const networkLabel = CARRIER_LABEL[carrier]

  // MTN verification hard block (admin toggle), exactly as the USSD recipient step.
  if (carrier === "MTN" && (await isRecipientBlocked("MTN", recipientLocal))) return { ok: false, reason: "bad_recipient" }

  // The buyer tier is the PAYER's (the sender), never the recipient's.
  const dialingPhone = "+233" + ghanaSignificant(i.senderLocal)
  const tier = await resolveBuyerTier(supabase, dialingPhone, products[0])

  let perProduct: { product: Product; pkgs: Awaited<ReturnType<typeof productPackages>> }[]
  try {
    perProduct = await Promise.all(products.map(async (product) => ({ product, pkgs: await productPackages(product, tier) })))
  } catch {
    return { ok: false, reason: "prices_unavailable" }
  }

  const paystackProvider = (product: Product): Provider => paystackProviderFromPhone(i.senderLocal) ?? PRODUCT_PROVIDER[product]
  const matches: Offer[] = []
  for (const { product, pkgs } of perProduct) {
    // Two packages of one size on one product: the cheaper.
    const cheapest = pkgs.filter((p) => p.mb === i.sizeMb).sort((a, b) => a.price - b.price || (a.id < b.id ? -1 : 1))[0]
    if (!cheapest) continue
    matches.push({
      network: product, networkLabel: PRODUCT_LABEL[product], bundleId: cheapest.id, size: cheapest.size, price: cheapest.price,
      recipientLocal, gift, tier, paystackProvider: paystackProvider(product),
    })
  }

  if (matches.length === 1) return { ok: true, offer: matches[0] }
  if (matches.length > 1) return { ok: false, reason: "choose_product", options: matches }

  const nearest = perProduct
    .flatMap(({ pkgs }) => pkgs)
    .sort((a, b) => Math.abs(a.mb - i.sizeMb) - Math.abs(b.mb - i.sizeMb) || a.price - b.price)
    .slice(0, 3)
    .map((p) => ({ size: sizeLabel(p.size), priceGhs: p.price }))
  return { ok: false, reason: "no_package", networkLabel, nearest }
}

export async function listPrices(
  supabase: SupabaseClient,
  senderLocal: string
): Promise<{ networkLabel: string; items: { size: string; priceGhs: number }[] } | null> {
  const { map } = await getPrefixValidationConfig()
  const carrier = detectNetworkWithMap(senderLocal, map)
  if (carrier === "UNKNOWN") return null
  const products = CARRIER_PRODUCTS[carrier]

  try {
    const tier = await resolveBuyerTier(supabase, "+233" + ghanaSignificant(senderLocal), products[0])
    const per = await Promise.all(products.map(async (product) => ({ product, pkgs: await productPackages(product, tier) })))
    const multi = products.length > 1
    const rows = per.flatMap(({ product, pkgs }) =>
      pkgs.map((p) => ({
        mb: p.mb,
        item: { size: multi ? `${sizeLabel(p.size)} ${product.replace("AT-", "")}` : sizeLabel(p.size), priceGhs: p.price },
      }))
    )
    if (rows.length === 0) return null
    rows.sort((a, b) => a.mb - b.mb || a.item.priceGhs - b.item.priceGhs)
    return { networkLabel: CARRIER_LABEL[carrier], items: rows.map((r) => r.item) }
  } catch {
    return null
  }
}

/**
 * The USSDSession handleConfirm needs, built in memory; nothing is read from or written to the session store.
 * dialingPhone is the sender in international form (+233...), the form the Uzo USSD menu stores from the operator's
 * msisdn, so orders written from this lane carry the same dialing_phone shape as USSD orders. walletBalance is left
 * unset on purpose: there is no wallet payment in this lane.
 */
export function sessionForOffer(senderLocal: string, o: Offer): USSDSession {
  return {
    step: "CONFIRM",
    dialingPhone: "+233" + ghanaSignificant(senderLocal),
    network: o.network,
    paystackProvider: o.paystackProvider,
    bundleId: o.bundleId,
    bundleSize: o.size,
    bundlePrice: o.price,
    recipientPhone: o.recipientLocal,
    effectivePriceTier: o.tier.effectivePriceTier,
    subAgentParentShopId: o.tier.subAgentParentShopId,
    userId: o.tier.userId,
    mtnWhitelistActive: o.tier.mtnWhitelistActive,
  }
}
