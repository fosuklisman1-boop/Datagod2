// Orders whose stored price has the payment fee inside it, checked by the handler against that price: storefront
// commission orders (paid_amount, checked to the pesewa) and storefront cashback airtime (total_paid). The fee depends
// on the gateway, so payments/initialize puts the stored price right if this payment ends up on a gateway it wasn't
// priced for, always before anything is charged.
import type { SupabaseClient } from "@supabase/supabase-js"
import { getCashbackConfig, type CashbackConfig } from "@/lib/cashback/config"
import { resolveSurfaceGateway } from "@/lib/payment-gateway/start"
import { storefrontAirtimeOn } from "@/lib/cashback/storefront-airtime"
import { commissionPriceChange, STOREFRONT_ORDER_TABLE, type CommissionPrice, type StorefrontOrderType } from "./payment"
import { storefrontGroupOn } from "./shop"

const FEE_GROUP = { cs_bill: "bills", cs_bundle: "bundles" } as const

/**
 * Does this storefront's next order carry no payment fee? Hubtel adds its own charge, and a merchant-borne fee isn't the
 * customer's. "Hubtel" here assumes a verified payer; a payment that doesn't qualify is re-priced at payment time.
 */
export async function storefrontPaymentFeeWaived(): Promise<boolean> {
  const { gateway, feeBearer } = await resolveSurfaceGateway("storefront", { verifiedPayer: true })
  return gateway === "hubtel" || feeBearer === "merchant"
}

/** Where an order's price lives, which rows may still be re-priced, and the fee rate a quote would use. */
export interface RepriceSpec {
  table: string
  amountColumn: string
  /** Equality guards: the row must still be unpaid in exactly this state. */
  payable: Record<string, string>
  feeRate: (cfg: CashbackConfig) => number
}

export function commissionRepriceSpec(orderType: StorefrontOrderType): RepriceSpec {
  const group = FEE_GROUP[orderType]
  return {
    table: STOREFRONT_ORDER_TABLE[orderType],
    amountColumn: "paid_amount",
    payable: { channel: "storefront", status: "pending", payment_status: "unpaid" },
    feeRate: (cfg) => (storefrontGroupOn(cfg, group) ? cfg.paymentFee[group] ?? 0 : 0),
  }
}

/** Storefront cashback airtime only: a legacy order has no payment fee in total_paid (its fee_amount is margin). */
export const AIRTIME_REPRICE_SPEC: RepriceSpec = {
  table: "airtime_orders",
  amountColumn: "total_paid",
  payable: { status: "pending_payment", payment_status: "pending_payment" },
  feeRate: (cfg) => (storefrontAirtimeOn(cfg) ? cfg.paymentFee.airtime ?? 0 : 0),
}

/**
 * Charge this order fee-free (`feeless`) or with the customer's fee, moving the stored price first if it was priced the
 * other way. ok:false means nothing may be charged: the fee couldn't be read, or the guarded write changed no row, so
 * the order is no longer unpaid at the price this request read.
 */
export async function priceOrderForGateway(
  db: SupabaseClient,
  spec: RepriceSpec,
  orderId: string,
  current: CommissionPrice,
  feeless: boolean,
): Promise<{ ok: true; price: CommissionPrice } | { ok: false }> {
  let feeRate = 0
  if (!feeless && current.fee === null) {
    try {
      feeRate = spec.feeRate(await getCashbackConfig(db))
    } catch (e) {
      console.error("[storefront-reprice] could not read the fee:", e instanceof Error ? e.message : "unknown error")
      return { ok: false }
    }
  }
  const change = commissionPriceChange(current, { feeless, feeRate })
  if (!change) return { ok: true, price: current }
  try {
    let q = db
      .from(spec.table)
      .update({ [spec.amountColumn]: change.paid, payment_fee_amount: change.fee, updated_at: new Date().toISOString() })
      .eq("id", orderId)
    for (const [column, value] of Object.entries(spec.payable)) q = q.eq(column, value)
    const { data, error } = await q.eq(spec.amountColumn, current.paid).select("id")
    if (error) {
      console.error("[storefront-reprice] write failed:", error.code ?? "no code")
      return { ok: false }
    }
    if (!data?.length) return { ok: false }
    return { ok: true, price: change }
  } catch (e) {
    console.error("[storefront-reprice] write threw:", e instanceof Error ? e.message : "unknown error")
    return { ok: false }
  }
}

/** priceOrderForGateway for a storefront commission order. */
export function priceCommissionOrder(
  db: SupabaseClient,
  orderType: StorefrontOrderType,
  orderId: string,
  current: CommissionPrice,
  feeless: boolean,
): Promise<{ ok: true; price: CommissionPrice } | { ok: false }> {
  return priceOrderForGateway(db, commissionRepriceSpec(orderType), orderId, current, feeless)
}
