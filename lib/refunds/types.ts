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

/** Shown for the wallet gateway on a storefront or bot commission order (the buyer is anonymous: no wallet). */
export const COMMISSION_NO_WALLET_REASON = "Storefront and bot customers have no wallet — refund through Paystack or a MoMo payout"

/**
 * Bot commission orders (bills / bundles, channel 'bots'): sold by a USSD / WhatsApp bot to an anonymous buyer
 * (user_id NULL), refunded here like storefront rows. Refund options: Paystack reversal (only when Paystack took the
 * payment), Moolre payout to the buyer's number, or "Mark refunded manually".
 */
export const BOT_CHANNEL = "bots"

/** Shown for gateways a bot order cannot use (e.g. the Paystack MoMo payout). */
export const BOT_GATEWAY_REASON = "Bot orders are refunded by Paystack reversal, a Moolre payout to the buyer, or manually"

const BOT_SURFACE_LABEL: Record<string, string> = {
  hubtel_ussd: "Hubtel USSD", ussd: "USSD", ussd_shop: "USSD shop", whatsapp: "WhatsApp", whatsapp_shop: "WhatsApp shop",
}

/** A loaded bot commission order (the loader sets botSurface, possibly null, on bot rows only). */
export const isBotOrder = (o: { botSurface?: string | null }): boolean => o.botSurface !== undefined

/** "Bot · <surface>" (unknown surfaces shown as stored). */
export const botSourceLabel = (surface: string | null | undefined): string =>
  `Bot · ${surface ? BOT_SURFACE_LABEL[surface] ?? surface : "unknown"}`

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
  /**
   * false => not refundable here (wallet-paid, or a legacy USSD/WhatsApp order). true for storefront rows AND bot
   * commission rows (bills/bundles channel 'bots'), which the refund RPCs accept alike.
   */
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
  /** Bot commission orders only (channel 'bots'): the bot surface that sold it. Absent on every other row. */
  botSurface?: string | null
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
  /** Manual gateway only: the admin's MoMo / bank reference for money sent by hand (optional). */
  manualReference?: string | null
}

/** Customer details shown to the admin for a manual refund (who to pay, how to reach them). */
export interface RefundContact {
  name: string | null
  email: string | null
  /** The customer's own phone: account phone (bulk/API) or the dialling number (USSD). */
  phone: string | null
  /** The number that paid (MoMo payer), when recorded. */
  payerPhone: string | null
  /** Who received the data; may be a third party, so it is never the suggested payout number. */
  recipientPhone: string | null
  /** Suggested number to send the refund to: payer, else the customer's own phone. null = ask the customer. */
  payTo: string | null
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
