/**
 * Read-only "verify at gateway": asks the refund's gateway what it thinks, WITHOUT settling anything
 * (no ledger RPCs). Used by GET /api/admin/refunds/[id]/gateway-status and the history UI.
 */
import { describePaystackRefund } from "./gateways/paystack"
import { RefundError, type RefundDeps, type StoredRefund } from "./service"
import type { GatewayOutcome } from "./types"

export interface GatewayStatusResult {
  refundId: string
  ledgerStatus: string
  gateway: string
  /** Outcome kind the gateway reported, or null when it could not be asked. */
  gatewayStatus: GatewayOutcome["kind"] | null
  /** Raw gateway status string (Paystack reversals only), null when unavailable. */
  rawStatus: string | null
  message: string
}

const messageOf = (o: GatewayOutcome): string =>
  "error" in o ? o.error : o.kind === "completed" ? "Gateway reports the refund as done" : o.kind === "otp" ? "Gateway is waiting for the payout OTP" : "Gateway reports the refund as still in progress"

/** Wallet's checkStatus is an idempotent CREDIT (it moves money), so it must never run from a read-only verify. */
const NOT_READ_ONLY = new Set(["wallet"])

export async function inspectGatewayStatus(deps: RefundDeps, stored: StoredRefund): Promise<GatewayStatusResult> {
  const base = { refundId: stored.id, ledgerStatus: stored.status, gateway: stored.gateway }
  const gateway = deps.getGateway(stored.gateway)
  if (!gateway?.checkStatus || NOT_READ_ONLY.has(stored.gateway) || !stored.gateway_ref) {
    return { ...base, gatewayStatus: null, rawStatus: null, message: !gateway?.checkStatus || NOT_READ_ONLY.has(stored.gateway) ? "This gateway cannot be verified automatically" : "No gateway reference is stored for this refund, so it cannot be looked up" }
  }
  let outcome: GatewayOutcome
  let rawStatus: string | null = null
  try {
    if (stored.gateway === "paystack") {
      const d = await describePaystackRefund(stored.gateway_ref)
      outcome = d.outcome
      rawStatus = d.rawStatus
    } else {
      const order = await deps.loadOrder(stored.order_table, stored.order_id)
      if (!order) throw new RefundError("NOT_FOUND", "Order not found")
      outcome = await gateway.checkStatus({ refundId: stored.id, order, amount: Number(stored.amount), destinationPhone: stored.destination_phone }, stored.gateway_ref)
    }
  } catch (err) {
    if (err instanceof RefundError) throw err
    outcome = { kind: "unknown", error: err instanceof Error ? err.message : "status check failed" }
  }
  return { ...base, gatewayStatus: outcome.kind, rawStatus, message: messageOf(outcome) }
}
