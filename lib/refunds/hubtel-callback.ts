import { verifyCallbackToken } from "./hubtel-refund"
import { applyGatewayOutcome, RefundError, type RefundDeps, type StoredRefund } from "./service"
import type { GatewayOutcome } from "./types"

export interface HubtelCallbackInput {
  refundId: string | null
  token: string | null
  body: unknown
  loadRefund(id: string): Promise<StoredRefund | null>
}

export interface HubtelCallbackResult {
  status: number
  body: { ok: boolean; note?: string }
}

const isPending = (r: StoredRefund) => r.status === "reserved" || r.status === "processing"
const ALREADY_SETTLED: HubtelCallbackResult = { status: 200, body: { ok: true, note: "already settled" } }

/** Untrusted text bound for a stored note: no control characters, capped length. */
const clean = (v: unknown): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120)

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null

function decide(stored: StoredRefund, body: unknown): GatewayOutcome {
  const root = asRecord(body)
  const data = asRecord(root?.data)
  if (
    root && data &&
    root.responseCode === "0000" &&
    typeof data.orderId === "string" && data.orderId === stored.gateway_ref &&
    Math.abs(Number(data.amount) - Number(stored.amount)) < 0.005
  ) {
    return { kind: "completed", ref: `${clean(data.externalTransactionId)} (charges GHS ${clean(data.charges)})` }
  }
  // Anything else is never trusted as a failure: park for an admin to review, keep the clawback.
  return { kind: "unknown", error: `Hubtel callback ${clean(root?.responseCode)}: ${clean(root?.message)} — review` }
}

export async function handleHubtelRefundCallback(deps: RefundDeps, input: HubtelCallbackInput): Promise<HubtelCallbackResult> {
  if (!input.refundId || !input.token || !verifyCallbackToken(input.refundId, input.token)) {
    return { status: 401, body: { ok: false } }
  }
  const first = await input.loadRefund(input.refundId)
  if (!first || first.gateway !== "hubtel") return { status: 404, body: { ok: false } }
  if (!isPending(first)) return ALREADY_SETTLED

  // Re-read right before settling so a concurrent duplicate callback that already settled is a no-op.
  const stored = await input.loadRefund(input.refundId)
  if (!stored || stored.gateway !== "hubtel") return { status: 404, body: { ok: false } }
  if (!isPending(stored)) return ALREADY_SETTLED

  try {
    await applyGatewayOutcome(deps, stored, decide(stored, input.body))
  } catch (e) {
    if (e instanceof RefundError && e.code === "ORDER_NOT_PENDING") return ALREADY_SETTLED
    throw e
  }
  return { status: 200, body: { ok: true } }
}
