/**
 * Read-only "verify at gateway": asks the refund's gateway what it thinks, WITHOUT settling anything
 * (no ledger RPCs). Used by GET /api/admin/refunds/[id]/gateway-status and the history UI.
 */
import { describePaystackRefund } from "./gateways/paystack"
import type { RefundDeps, StoredRefund } from "./service"
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

export const PAYSTACK_ONLY_MESSAGE = "Verification is only available for Paystack reversals"

/** Read-only lookup at Paystack. Callers must check stored.gateway === "paystack" first (the route returns 400 otherwise). */
export async function inspectGatewayStatus(_deps: RefundDeps, stored: StoredRefund): Promise<GatewayStatusResult> {
  const base = { refundId: stored.id, ledgerStatus: stored.status, gateway: stored.gateway }
  if (stored.gateway !== "paystack") {
    return { ...base, gatewayStatus: null, rawStatus: null, message: PAYSTACK_ONLY_MESSAGE }
  }
  if (!stored.gateway_ref) {
    return { ...base, gatewayStatus: null, rawStatus: null, message: "No gateway reference is stored for this refund, so it cannot be looked up" }
  }
  const d = await describePaystackRefund(stored.gateway_ref)
  return { ...base, gatewayStatus: d.outcome.kind, rawStatus: d.rawStatus, message: messageOf(d.outcome) }
}
