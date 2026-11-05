// A storefront commission order's paid_amount has the payment fee inside it, and confirm checks it to the pesewa. The
// fee depends on the gateway, so the order is priced for the gateway resolved at creation, and payments/initialize puts
// it right if this payment ends up on the other one, always before anything is charged.
import type { SupabaseClient } from "@supabase/supabase-js"
import { getCashbackConfig } from "@/lib/cashback/config"
import { resolveSurfaceGateway } from "@/lib/payment-gateway/start"
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

/**
 * Charge this order fee-free (`feeless`) or with the customer's fee, moving paid_amount first if it was priced the other
 * way. ok:false means nothing may be charged: the fee couldn't be read, or the guarded write changed no row, so the
 * order is no longer unpaid at the price this request read.
 */
export async function priceCommissionOrder(
  db: SupabaseClient,
  orderType: StorefrontOrderType,
  orderId: string,
  current: CommissionPrice,
  feeless: boolean,
): Promise<{ ok: true; price: CommissionPrice } | { ok: false }> {
  let feeRate = 0
  if (!feeless && current.fee === null) {
    try {
      const cfg = await getCashbackConfig(db)
      const group = FEE_GROUP[orderType]
      feeRate = storefrontGroupOn(cfg, group) ? cfg.paymentFee[group] ?? 0 : 0
    } catch (e) {
      console.error("[storefront-reprice] could not read the fee:", e instanceof Error ? e.message : "unknown error")
      return { ok: false }
    }
  }
  const change = commissionPriceChange(current, { feeless, feeRate })
  if (!change) return { ok: true, price: current }
  try {
    const { data, error } = await db
      .from(STOREFRONT_ORDER_TABLE[orderType])
      .update({ paid_amount: change.paid, payment_fee_amount: change.fee, updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .eq("channel", "storefront")
      .eq("status", "pending")
      .eq("payment_status", "unpaid")
      .eq("paid_amount", current.paid)
      .select("id")
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
