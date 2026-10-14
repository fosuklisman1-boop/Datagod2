// lib/ussd-hubtel/flows/airtime-cashback.ts
// Commission-cashback pricing shared by the main and shop Hubtel airtime flows. Only used when
// deps.airtime.cashbackQuote returned an applied quote; otherwise the flows run today's fee pricing
// untouched. Applied: the amount typed is the airtime FACE (what the recipient receives, no fee
// deducted); the caller pays quote.payAmount (face - cashback + payment fee) as the Hubtel price.
import type { StorefrontQuote } from "@/lib/cashback/quote"

/**
 * Confirm screen when cashback applies. `header` is "Confirm Airtime" (main) or the shop header.
 * "(was GHS face)" only when the caller actually pays less than face. Fits 182 chars for a 30-char
 * header, any network label and amounts up to GHS 99999.99 (tested).
 */
export function cashbackAirtimeConfirmText(
  header: string, label: string, recipient: string, pay: number, face: number, payerLocal: string,
): string {
  const was = pay < face ? ` (was GHS ${face.toFixed(2)})` : ""
  return (
    `${header}\n${label} to ${recipient}\nPay GHS ${pay.toFixed(2)}${was}\n` +
    `You receive GHS ${face.toFixed(2)} ${label} airtime\nfrom ${payerLocal}\n1. Pay now\n2. Cancel`
  )
}

/** A quote the flows may sell at: applied, finite, positive price (fail closed otherwise). */
export function usableCashbackQuote(q: StorefrontQuote | null, face: number): q is StorefrontQuote {
  return !!q && q.applied === true && Number.isFinite(q.payAmount) && q.payAmount > 0 &&
    Number.isFinite(q.faceAmount) && Math.abs(q.faceAmount - face) < 0.001 &&
    Number.isFinite(q.paymentFee) && q.paymentFee >= 0 &&
    Number.isFinite(q.customerCashback) && q.customerCashback >= 0 &&
    Number.isFinite(q.shopShare) && q.shopShare >= 0
}

/**
 * airtime_orders columns that differ from the legacy row when cashback applies: face delivered, no
 * fee, total = pay amount, plus the cashback snapshot (same columns as the storefront airtime insert).
 * `shopShare` is passed separately so main mode always snapshots 0.
 */
export function cashbackAirtimeColumns(q: StorefrontQuote, shopShare: number): Record<string, unknown> {
  return {
    airtime_amount: q.faceAmount,
    fee_amount: 0,
    total_paid: q.payAmount,
    payment_fee_amount: q.paymentFee,
    cashback_amount: q.customerCashback,
    shop_share_amount: shopShare,
    cashback_rate: q.rate,
    cashback_share: q.share,
    cashback_provider: q.provider,
    expected_commission: q.commission,
  }
}
