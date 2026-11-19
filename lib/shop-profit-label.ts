/**
 * Human label for a `shop_profits` row on the shop owner's Profit Logs page.
 *
 * Every service credits the shop through the same table but links a different
 * order column, so the link that is set says what the money was for. Rows with
 * no order link (refund reversals, debt recovery, admin credits/debits) carry
 * their reason in `description` / `notes`.
 */
export interface ShopProfitRow {
  shop_order_id?: string | null
  shop_orders?: { network?: string | null; volume_gb?: number | string | null; customer_name?: string | null } | null
  bill_order_id?: string | null
  data_order_id?: string | null
  airtime_order_id?: string | null
  results_checker_order_id?: string | null
  results_check_request_id?: string | null
  ussd_shop_order_id?: string | null
  ussd_order_id?: string | null
  refund_id?: string | null
  description?: string | null
  notes?: string | null
  adjustment_type?: string | null
}

// Checked in order; first link that is set wins.
const LINK_LABELS: Array<[keyof ShopProfitRow, string]> = [
  ["bill_order_id", "Bill payment commission"],
  ["data_order_id", "Bundle commission"],
  ["airtime_order_id", "Airtime commission"],
  ["results_checker_order_id", "Results checker commission"],
  ["results_check_request_id", "Results check commission"],
  ["ussd_shop_order_id", "USSD shop sale"],
  ["ussd_order_id", "Sub-agent USSD sale"],
]

export function describeShopProfit(p: ShopProfitRow): string {
  if (p.shop_orders) {
    return `${p.shop_orders.network} ${p.shop_orders.volume_gb}GB — ${p.shop_orders.customer_name || "Customer"}`
  }
  for (const [key, label] of LINK_LABELS) {
    if (p[key]) return label
  }
  const text = (p.description || p.notes || "").trim()
  if (text) return text
  if (p.refund_id) return "Refund adjustment"
  return "Order profit"
}

/** `sign` is the entry type's direction; a negative earning flips to "-" instead of rendering "+GH₵-1.00". */
export function formatSignedGhs(amount: number, sign: "+" | "-"): string {
  const outgoing = sign === "-" || amount < 0
  return `${outgoing ? "-" : "+"}GH₵${Math.abs(amount).toFixed(2)}`
}
