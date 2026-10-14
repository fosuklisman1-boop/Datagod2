import { effectiveShares, groupOf, type CashbackChannel, type CashbackConfig, type CashbackProvider } from "./config"

export interface QuoteInput {
  serviceKey: string
  provider: CashbackProvider | "manual"
  faceAmount: number
  buyer: "customer" | "dealer"
  channel: CashbackChannel
  /** Order is placed through a shop (storefront split applies). Also implied by channel "storefront". */
  shop?: boolean
}
export interface CashbackQuote {
  applied: boolean
  faceAmount: number
  rate: number
  share: number
  commission: number
  customerCashback: number
  shopShare: number
  payAmount: number
  datagodKeeps: number
  provider: string
}

export const toPesewas = (n: number): number => Math.round(n * 100)
export const samePrice = (a: number, b: number): boolean => Math.abs(toPesewas(a) - toPesewas(b)) < 1

const round4 = (n: number): number => Math.round(n * 10000) / 10000
const fromPesewas = (p: number): number => p / 100
const floorShare = (facePesewas: number, rate: number, share: number): number =>
  Math.floor((facePesewas * rate * share) / 10000 + 1e-9)

function notApplied(i: QuoteInput): CashbackQuote {
  return {
    applied: false, faceAmount: i.faceAmount, rate: 0, share: 0, commission: 0,
    customerCashback: 0, shopShare: 0, payAmount: i.faceAmount, datagodKeeps: 0, provider: i.provider,
  }
}

export interface StorefrontQuote extends CashbackQuote {
  /** Amount the customer pays before the payment fee (face minus customer cashback). */
  base: number
  paymentFee: number
  feeRate: number
}

/** Storefront quote: cashback split plus the payment fee on the base, rounded UP to the pesewa. */
export function quoteStorefront(i: Omit<QuoteInput, "channel" | "shop">, cfg: CashbackConfig): StorefrontQuote {
  const q = quoteCashback({ ...i, channel: "storefront", shop: true }, cfg)
  const group = groupOf(i.serviceKey)
  const on = !!group && cfg.enabled && cfg.surfaces.storefront && cfg.storefrontGroups[group]
  if (!on) {
    const n = notApplied({ ...i, channel: "storefront", shop: true })
    return { ...n, base: n.payAmount, paymentFee: 0, feeRate: 0 }
  }
  const feeRate = cfg.paymentFee[group] ?? 0
  const basePesewas = toPesewas(q.payAmount)
  const feePesewas = feeRate > 0 ? Math.ceil((basePesewas * feeRate) / 100 - 1e-9) : 0
  return { ...q, base: q.payAmount, paymentFee: fromPesewas(feePesewas), feeRate, payAmount: fromPesewas(basePesewas + feePesewas) }
}

export function quoteCashback(i: QuoteInput, cfg: CashbackConfig): CashbackQuote {
  if (!cfg.enabled || !cfg.surfaces[i.channel] || i.provider === "manual" || groupOf(i.serviceKey) === null) return notApplied(i)
  if (!Number.isFinite(i.faceAmount) || i.faceAmount <= 0) return notApplied(i)

  const rate = cfg.rates[`${i.serviceKey}:${i.provider}`] ?? 0
  if (!(rate > 0)) return notApplied(i)

  const shares = effectiveShares(cfg, i.serviceKey)
  const storefront = i.channel === "storefront" || i.shop === true
  const share = storefront ? shares.storefrontCustomer : shares[i.buyer]
  // Storefront: a shop-only split (customer 0, shop > 0) is still applied.
  if (!(share > 0) && !(storefront && shares.storefrontShop > 0)) return notApplied(i)

  const facePesewas = toPesewas(i.faceAmount)
  const customerP = floorShare(facePesewas, rate, share)
  const shopP = storefront ? floorShare(facePesewas, rate, shares.storefrontShop) : 0
  // Eligible but the floor gives 0 pesewas (small amounts): still a cashback-priced sale — the old fee is gone
  // wherever cashback is on, so the buyer pays face (applied, cashback 0) instead of falling back to the fee.
  // Guarantee: never give away more than the provider commission, and never charge below 1 pesewa.
  if (customerP + shopP > (facePesewas * rate) / 100 + 1e-9) return notApplied(i)
  if (facePesewas - customerP < 1) return notApplied(i)

  const commission = round4((facePesewas * rate) / 10000)
  const customerCashback = fromPesewas(customerP)
  const shopShare = fromPesewas(shopP)
  return {
    applied: true,
    faceAmount: i.faceAmount,
    rate,
    share,
    commission,
    customerCashback,
    shopShare,
    payAmount: fromPesewas(facePesewas - customerP),
    datagodKeeps: round4(commission - customerCashback - shopShare),
    provider: i.provider,
  }
}
