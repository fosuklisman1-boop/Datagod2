/**
 * Storefront commission orders (Hubtel Commission cashback): airtime, utility bills, standard bundles. Only rows a
 * storefront customer paid through Paystack belong here (airtime: shop_id set, user_id NULL; bills/bundles:
 * channel 'storefront'); the refund RPCs raise BAD_CHANNEL for any wallet-paid row.
 */
export type CommissionTable = "airtime_orders" | "hubtel_bill_orders" | "hubtel_data_orders"
export const COMMISSION_TABLES: readonly CommissionTable[] = ["airtime_orders", "hubtel_bill_orders", "hubtel_data_orders"]
export const isCommissionTable = (t: string): t is CommissionTable => (COMMISSION_TABLES as readonly string[]).includes(t)

export type OrderTable = "shop_orders" | "ussd_orders" | "ussd_shop_orders" | "orders" | "api_orders" | CommissionTable
export const ORDER_TABLES: OrderTable[] = ["shop_orders", "ussd_orders", "ussd_shop_orders", "orders", "api_orders", ...COMMISSION_TABLES]

/** Shown for the wallet gateway on a storefront commission order (the buyer is anonymous: no wallet). */
export const COMMISSION_NO_WALLET_REASON = "Storefront customer has no wallet — refund through Paystack or a MoMo payout"

/** One hubtel_cs_transactions row as the refund eligibility check needs it. */
export interface CommissionLedgerFact {
  client_reference: string
  state: "created" | "pending" | "fulfilled" | "failed" | "needs_review"
  refund_claimed_at: string | null
  resolved_by: string | null
  created_at: string
}

/** Raw order facts for a commission order (status/payment_status exactly as stored). */
/**
 * Storefront airtime is refundable on /admin/refunds only for orders created at/after the cashback-storefront launch.
 * Older paid failed/pending storefront airtime was handled out of band (nothing on the row records it), so listing it
 * here could pay a customer twice.
 */
export const STOREFRONT_REFUNDS_FROM = "2026-10-14T00:00:00Z"

export const isBeforeStorefrontRefunds = (createdAt: string | null | undefined): boolean => {
  const t = Date.parse(String(createdAt ?? ""))
  // Unknown creation time: fail closed.
  return !Number.isFinite(t) || t < Date.parse(STOREFRONT_REFUNDS_FROM)
}

export interface CommissionEvidence {
  /** false => not a storefront row (wallet-paid or a USSD/WhatsApp order): never refundable here. */
  storefront: boolean
  status: string
  /** Raw: airtime 'completed' when paid; bills/bundles 'paid'. */
  paymentStatus: string
  hubtelClientReference: string | null
  notes: string | null
  updatedAt: string
  /** Order creation time (airtime: the STOREFRONT_REFUNDS_FROM cutoff). Absent = not checked (bills/bundles). */
  createdAt?: string
  ledger: CommissionLedgerFact[]
}

/** Dashboard/bulk (`orders`) and API (`api_orders`) orders: paid from the buyer's wallet, no shop owners, wallet refund only. */
export const WALLET_ONLY_TABLES: readonly OrderTable[] = ["orders", "api_orders"]
export const isWalletOnlyTable = (t: OrderTable): boolean => WALLET_ONLY_TABLES.includes(t)

/** Shown for every non-wallet gateway on a wallet-only order. */
export const WALLET_ONLY_REASON = "Paid from wallet — refund goes back to the buyer's wallet"

export interface OwnerCut {
  shopId: string
  ownerUserId: string | null
  credited: number
  pending: number
  availableBalance: number
  walletBalance: number
}

export type DispatchOutcome = "claimed" | "submitted" | "failed" | "unknown"

export interface PaymentSource {
  gateway: "paystack" | "wallet" | null
  reference: string | null
  payerPhone: string | null
  walletUserId: string | null
}

export interface RefundableOrder {
  table: OrderTable
  id: string
  orderStatus: string
  paymentStatus: string
  shopId: string | null
  shopName: string | null
  packageLabel: string
  network: string
  recipientPhone: string | null
  /** The account that paid (orders/api_orders only): its phone receives the refund SMS, never the data recipient. */
  buyerUserId?: string | null
  createdAt: string
  paid: number
  gatewayFee: number
  payment: PaymentSource
  owners: OwnerCut[]
  evidence: {
    hasActiveRefund: boolean
    dispatchOutcome: DispatchOutcome | null
    /** order_dispatch_claims.attempts at load time (null = no claims row). */
    dispatchAttempts: number | null
    trackingStatuses: string[]
    externalOrderId: string | null
    /** Commission tables only. */
    commission?: CommissionEvidence
  }
}

export interface RefundContext {
  refundId: string
  order: RefundableOrder
  amount: number
  destinationPhone: string | null
}

export type GatewayOutcome =
  | { kind: "completed"; ref: string }
  | { kind: "pending"; ref: string }
  | { kind: "otp"; ref: string }          // payout created, waiting for the admin's OTP; ref = transfer code
  | { kind: "failed"; error: string }
  | { kind: "unknown"; error: string }

export type GatewaySupport = { ok: true } | { ok: false; reason: string }

export interface RefundGateway {
  id: string
  label: string
  supports(order: RefundableOrder): GatewaySupport
  refund(ctx: RefundContext): Promise<GatewayOutcome>
  checkStatus?(ctx: RefundContext, gatewayRef: string | null): Promise<GatewayOutcome>
  /** Only gateways whose payout needs a one-time code (Paystack payout). */
  finalizeOtp?(ctx: RefundContext, gatewayRef: string, otp: string): Promise<GatewayOutcome>
}
