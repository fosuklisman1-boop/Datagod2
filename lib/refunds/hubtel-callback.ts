import { verifyCallbackToken } from "./hubtel-refund"
import { applyGatewayOutcome, RefundError, type RefundDeps, type StoredRefund } from "./service"
import type { GatewayOutcome } from "./types"

export interface HubtelCallbackInput {
  refundId: string | null
  token: string | null
  body: unknown
  loadRefund(id: string): Promise<StoredRefund | null>
  /** Flags a `failed` refund that Hubtel reports as paid (possible double refund). Must not throw. */
  markConflict(refundId: string): Promise<void>
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

/**
 * The Hubtel orderId this refund was sent for. gateway_ref is NULL while the row is still `reserved` (the callback
 * beat mark_refund_processing) or after an `unknown` send, so fall back to the order's single paid Hubtel row — the
 * id the gateway sent. Any doubt (load error, no facts, several paid rows) leaves only gateway_ref: fail closed.
 */
async function expectedOrderId(deps: RefundDeps, stored: StoredRefund): Promise<string | null> {
  if (stored.gateway_ref) return stored.gateway_ref
  try {
    const order = await deps.loadOrder(stored.order_table, stored.order_id)
    const h = order?.payment.hubtel
    return h && h.paidRows === 1 && typeof h.orderId === "string" && h.orderId ? h.orderId : null
  } catch {
    return stored.gateway_ref
  }
}

function decide(stored: StoredRefund, expected: string | null, body: unknown): GatewayOutcome {
  const root = asRecord(body)
  const data = asRecord(root?.data)
  const park = (why: string): GatewayOutcome => ({ kind: "unknown", error: `Hubtel callback ${why} — review` })
  // Anything but a fully matching success is never trusted as a failure: park for an admin to review, keep the clawback.
  if (!root || root.responseCode !== "0000" || !data) return park(`code ${clean(root?.responseCode)}: ${clean(root?.message)}`)
  if (typeof expected !== "string" || !expected || typeof data.orderId !== "string" || data.orderId !== expected) {
    return park("orderId mismatch")
  }
  if (!(Math.abs(Number(data.amount) - Number(stored.amount)) < 0.005)) {
    return park(`amount got ${clean(data.amount)} expected ${clean(stored.amount)}`)
  }
  // complete_order_refund replaces the stored gateway_ref with this string, so it must keep the Hubtel orderId.
  return { kind: "completed", ref: `${expected} ext:${clean(data.externalTransactionId) || "-"} charges:GHS ${clean(data.charges) || "?"}` }
}

/** A settled row: a matching success on a `failed` refund means money may have gone out twice — flag it. */
async function settledResult(deps: RefundDeps, input: HubtelCallbackInput, stored: StoredRefund): Promise<HubtelCallbackResult> {
  if (stored.status !== "failed") return ALREADY_SETTLED
  if (decide(stored, await expectedOrderId(deps, stored), input.body).kind !== "completed") return ALREADY_SETTLED
  await input.markConflict(stored.id)
  console.error("[HUBTEL-REFUND-CALLBACK] CONFLICT refund", stored.id)
  return { status: 200, body: { ok: true, note: "conflict" } }
}

export async function handleHubtelRefundCallback(deps: RefundDeps, input: HubtelCallbackInput): Promise<HubtelCallbackResult> {
  if (!input.refundId || !input.token || !verifyCallbackToken(input.refundId, input.token)) {
    return { status: 401, body: { ok: false } }
  }
  const first = await input.loadRefund(input.refundId)
  if (!first || first.gateway !== "hubtel") return { status: 404, body: { ok: false } }
  if (!isPending(first) && first.status !== "failed") return ALREADY_SETTLED

  // Re-read right before settling so a concurrent duplicate callback that already settled is a no-op.
  const stored = await input.loadRefund(input.refundId)
  if (!stored || stored.gateway !== "hubtel") return { status: 404, body: { ok: false } }
  if (!isPending(stored)) return settledResult(deps, input, stored)

  try {
    await applyGatewayOutcome(deps, stored, decide(stored, await expectedOrderId(deps, stored), input.body))
  } catch (e) {
    if (e instanceof RefundError && e.code === "ORDER_NOT_PENDING") return ALREADY_SETTLED
    throw e
  }
  return { status: 200, body: { ok: true } }
}
