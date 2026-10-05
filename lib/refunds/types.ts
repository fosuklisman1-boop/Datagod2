export type OrderTable = "shop_orders" | "ussd_orders" | "ussd_shop_orders"
export const ORDER_TABLES: OrderTable[] = ["shop_orders", "ussd_orders", "ussd_shop_orders"]

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
  createdAt: string
  paid: number
  gatewayFee: number
  payment: PaymentSource
  owners: OwnerCut[]
  evidence: {
    hasActiveRefund: boolean
    dispatchOutcome: DispatchOutcome | null
    trackingStatuses: string[]
    externalOrderId: string | null
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
