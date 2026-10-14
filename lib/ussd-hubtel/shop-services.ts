// lib/ussd-hubtel/shop-services.ts
// Shop-mode business lookups, behind an interface so router/flow tests use fakes. Defaults reuse
// the channel-agnostic lib/shop-commerce modules shared by the Uzo shop code and the WhatsApp
// shop bot. The Uzo-private shop airtime fee rate (lib/ussd-shop/handlers/airtime.ts) is ported here
// with identical money logic.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BundleOption } from "@/lib/ussd/types"
import type { ExamBoard } from "@/lib/results-check-validation"
import { airtimeBaseFeeRate, airtimeNetworkKey, splitInclusive } from "@/lib/airtime-pricing"
import { calculateRCPrice } from "@/lib/results-checker-service"
import { fetchShopBundles, shopOwnerIsDealer, verifyBundlePrice } from "@/lib/shop-commerce/pricing"
import { fetchShopNetworks, getCanonicalShopName, resolveShopCode, type ResolvedShopCode } from "@/lib/shop-commerce/shop-code"
import { resolveEmail } from "@/lib/ussd/resolve-email"

export type { ResolvedShopCode }

export interface ShopAirtimeRates {
  /** Platform base rate for the shop owner's tier + the shop's (capped) markup, in %. */
  totalFeeRate: number
  /** The shop's markup share, in %: becomes merchant_commission. */
  merchantCommissionRate: number
}

export interface ShopServices {
  resolveCode(code: string): Promise<ResolvedShopCode | null>
  /** Distinct packages.network values the shop's data catalog offers (unsorted). */
  networks(shopId: string, parentShopId?: string): Promise<string[]>
  /** Every bundle of `network` at the shop's price, smallest first. */
  bundles(shopId: string, network: string, parentShopId?: string): Promise<BundleOption[]>
  /** Shop price + profit snapshot straight from the DB; null when no longer sold. */
  verifyBundlePrice(
    shopId: string, bundleId: string, parentShopId?: string
  ): Promise<{ verifiedPrice: number; profitAmount: number; parentProfitAmount: number } | null>
  /** Values the Uzo shop stores on ussd_shop_orders besides the price. */
  orderContext(shopId: string, dialingPhone: string): Promise<{ shopName: string; customerEmail: string | null; shopOwnerEmail: string | null }>
  airtimeFeeRate(shopId: string, network: string): Promise<ShopAirtimeRates>
  /** Voucher price with the shop's markup (bulk base when the threshold is met), as the Uzo shop. */
  rcPrice(board: ExamBoard, quantity: number, shopId: string): Promise<{ unitPrice: number; totalPaid: number; bulkApplied: boolean; merchantCommission: number }>
}

/** Uzo shopAirtimeFeeRate cap: base + markup <= 10%, markup never negative. */
export function capShopAirtimeMarkup(baseRate: number, rawMarkup: number): number {
  return Math.max(0, Math.min(rawMarkup, 10 - baseRate))
}

/** Uzo shop airtime split: fee-inclusive; the shop earns the markup share of what is delivered. */
export function shopAirtimeQuote(amount: number, rates: ShopAirtimeRates): { fee: number; toDeliver: number; commission: number } {
  const { fee, toDeliver } = splitInclusive(amount, rates.totalFeeRate)
  const commission = parseFloat(((toDeliver * rates.merchantCommissionRate) / 100).toFixed(2))
  return { fee, toDeliver, commission }
}

export async function shopAirtimeFeeRate(supabase: SupabaseClient, shopId: string, network: string): Promise<ShopAirtimeRates> {
  const isDealer = await shopOwnerIsDealer(shopId) // dealer/admin owner => dealer base rate
  const baseRate = await airtimeBaseFeeRate(network, isDealer)
  const column = `airtime_markup_${airtimeNetworkKey(network)}`
  const { data: shop } = await supabase.from("user_shops").select(column).eq("id", shopId).single()
  const raw = (shop as Record<string, unknown> | null)?.[column]
  const rawMarkup = Number.parseFloat(String(raw ?? 0)) || 0
  const markup = capShopAirtimeMarkup(baseRate, rawMarkup)
  return { totalFeeRate: baseRate + markup, merchantCommissionRate: markup }
}

async function shopOrderContext(supabase: SupabaseClient, shopId: string, dialingPhone: string) {
  const [customerEmail, owner, shopName] = await Promise.all([
    resolveEmail(dialingPhone).catch(() => null),
    supabase.from("user_shops").select("user_id, users!inner(email)").eq("id", shopId).single().then(r => r.data),
    getCanonicalShopName(shopId),
  ])
  const shopOwnerEmail = (owner as { users?: { email?: string | null } } | null)?.users?.email ?? null
  return { shopName, customerEmail: customerEmail ?? null, shopOwnerEmail }
}

export function defaultShopServices(supabase: SupabaseClient): ShopServices {
  return {
    resolveCode: code => resolveShopCode(code),
    networks: (shopId, parentShopId) => fetchShopNetworks(shopId, parentShopId ?? null),
    bundles: (shopId, network, parentShopId) => fetchShopBundles(shopId, network, parentShopId),
    verifyBundlePrice: (shopId, bundleId, parentShopId) => verifyBundlePrice(shopId, bundleId, parentShopId),
    orderContext: (shopId, dialingPhone) => shopOrderContext(supabase, shopId, dialingPhone),
    airtimeFeeRate: (shopId, network) => shopAirtimeFeeRate(supabase, shopId, network),
    rcPrice: async (examBoard, quantity, shopId) => {
      const r = await calculateRCPrice({ examBoard, quantity, shopId, applyBulk: true })
      return { unitPrice: r.unitPrice, totalPaid: r.totalPaid, bulkApplied: r.bulkApplied, merchantCommission: r.merchantCommission }
    },
  }
}
