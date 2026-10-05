import type { SupabaseClient } from "@supabase/supabase-js"
import { planClawback, type ClawbackPlan } from "./clawback"
import { evaluateEligibility, type Eligibility } from "./eligibility"
import { defaultRefundAmount, validateRefundAmount } from "./amounts"
import { loadRefundableOrders } from "./orders"
import { getGateway, listGateways } from "./gateways"
import { notifyRefund, type RefundNotification } from "./notify"
import type { GatewayOutcome, OrderTable, RefundContext, RefundGateway, RefundableOrder } from "./types"

export const REFUND_ERROR_CODES = [
  "NOT_FOUND", "NOT_ELIGIBLE", "GATEWAY_UNSUPPORTED", "BAD_AMOUNT", "BAD_OTP", "SHORTFALL",
  "ALREADY_REFUNDED", "ORDER_NOT_PENDING", "DISPATCH_ACTIVE", "RESERVE_FAILED", "SETTLE_FAILED",
] as const
export type RefundErrorCode = (typeof REFUND_ERROR_CODES)[number]

export class RefundError extends Error {
  constructor(public code: RefundErrorCode, message: string, public detail?: unknown) {
    super(message)
    this.name = "RefundError"
  }
}

export function mapReserveError(message: string): RefundError {
  const short = message.match(/SHORTFALL:([\w-]+):([0-9.]+)/i)
  if (short) return new RefundError("SHORTFALL", `Shop owner cannot cover their cut (short by GHS ${short[2]})`, { shopId: short[1], amount: Number(short[2]) })
  if (message.includes("ALREADY_REFUNDED")) return new RefundError("ALREADY_REFUNDED", "This order already has a refund")
  if (message.includes("ORDER_NOT_PENDING")) return new RefundError("ORDER_NOT_PENDING", "Order is no longer a paid, pending order")
  if (message.includes("DISPATCH_ACTIVE")) return new RefundError("DISPATCH_ACTIVE", "Order is being sent to a provider right now")
  return new RefundError("RESERVE_FAILED", message)
}

export interface RefundDeps {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: any; error: { message: string } | null }>
  loadOrder(table: OrderTable, id: string): Promise<RefundableOrder | null>
  getGateway(id: string): RefundGateway | undefined
  notify(event: RefundNotification): Promise<void>
}

export function defaultDeps(db: SupabaseClient): RefundDeps {
  return {
    rpc: (name, args) => db.rpc(name, args) as any,
    loadOrder: async (table, id) => (await loadRefundableOrders(db, [{ table, id }]))[0] ?? null,
    getGateway,
    notify: (e) => notifyRefund(db, e),
  }
}

const eligibilityOf = (o: RefundableOrder): Eligibility =>
  evaluateEligibility({
    orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, hasActiveRefund: o.evidence.hasActiveRefund,
    dispatchOutcome: o.evidence.dispatchOutcome, trackingStatuses: o.evidence.trackingStatuses,
    externalOrderId: o.evidence.externalOrderId,
  })

export interface RefundPreview {
  order: RefundableOrder
  eligibility: Eligibility
  defaultAmount: number
  gateways: { id: string; label: string; ok: boolean; reason?: string }[]
  clawback: ClawbackPlan
}

export async function previewRefund(deps: RefundDeps, ref: { table: OrderTable; id: string }): Promise<RefundPreview> {
  const order = await deps.loadOrder(ref.table, ref.id)
  if (!order) throw new RefundError("NOT_FOUND", "Order not found")
  return {
    order,
    eligibility: eligibilityOf(order),
    defaultAmount: defaultRefundAmount(order.paid, order.gatewayFee),
    gateways: listGateways().map((g) => {
      const s = g.supports(order)
      return { id: g.id, label: g.label, ok: s.ok, reason: s.ok ? undefined : s.reason }
    }),
    clawback: planClawback(order.owners),
  }
}

export type Settled = { status: "completed" | "processing" | "awaiting_otp" | "failed"; message?: string }

const refOf = (o: GatewayOutcome): string | null => ("ref" in o ? o.ref : null)

async function callRpc(deps: RefundDeps, name: string, args: Record<string, unknown>) {
  try {
    return await deps.rpc(name, args)
  } catch (e) {
    return { data: null, error: { message: e instanceof Error ? e.message : "rpc threw" } }
  }
}

/** Best-effort: make a row whose gateway result we could not record reconcilable. Never throws. */
async function parkForReconcile(deps: RefundDeps, refundId: string, ref: string | null): Promise<void> {
  const { error } = await callRpc(deps, "mark_refund_processing", {
    p_refund_id: refundId, p_gateway_ref: ref,
    p_note: "Payout done but ledger settle failed — reconcile", p_status: "processing",
  })
  if (error) console.error("[REFUND] could not park refund for reconcile:", refundId, error.message)
}

async function settleRpc(deps: RefundDeps, name: string, args: Record<string, unknown>, outcome: GatewayOutcome): Promise<unknown> {
  const { data, error } = await callRpc(deps, name, args)
  if (error) {
    throw new RefundError(
      "SETTLE_FAILED",
      `The payout result was "${outcome.kind}" but recording it failed (${error.message}). The refund ledger needs a manual look before any retry.`,
      { outcome: outcome.kind, rpc: name, refundId: args.p_refund_id, ref: refOf(outcome), error: error.message },
    )
  }
  return data
}

/** fail_order_refund must report 'failed'; anything else means the refund had already completed. */
async function compensate(deps: RefundDeps, refundId: string, error: string, outcome: GatewayOutcome): Promise<void> {
  const ledgerStatus = await settleRpc(deps, "fail_order_refund", { p_refund_id: refundId, p_error: error }, outcome)
  if (ledgerStatus !== "failed") {
    throw new RefundError(
      "SETTLE_FAILED",
      `Could not mark the refund failed: the ledger says it is "${String(ledgerStatus)}". Nothing was restored.`,
      { conflict: true, ledgerStatus, outcome: outcome.kind, ref: refOf(outcome), refundId },
    )
  }
}

async function settle(deps: RefundDeps, refundId: string, outcome: GatewayOutcome): Promise<Settled> {
  switch (outcome.kind) {
    case "completed": {
      let ledgerStatus: unknown
      try {
        ledgerStatus = await settleRpc(deps, "complete_order_refund", { p_refund_id: refundId, p_gateway_ref: outcome.ref }, outcome)
      } catch (e) {
        await parkForReconcile(deps, refundId, outcome.ref)
        throw e
      }
      if (ledgerStatus !== "completed") {
        throw new RefundError(
          "SETTLE_FAILED",
          `The gateway reports the payout completed but the ledger is "${String(ledgerStatus)}" — money has left; manual reconciliation required.`,
          { conflict: true, ledgerStatus, outcome: outcome.kind, ref: outcome.ref, refundId,
            note: `gateway reports the payout completed but the ledger is ${String(ledgerStatus)} — money has left; manual reconciliation required` },
        )
      }
      return { status: "completed" }
    }
    case "pending": {
      await settleRpc(deps, "mark_refund_processing", { p_refund_id: refundId, p_gateway_ref: outcome.ref, p_note: "Accepted by gateway, awaiting confirmation", p_status: "processing" }, outcome)
      return { status: "processing", message: "Payout accepted — awaiting gateway confirmation" }
    }
    case "otp": {
      // The transfer code is persisted on the ledger so a closed tab never loses it.
      await settleRpc(deps, "mark_refund_processing", { p_refund_id: refundId, p_gateway_ref: outcome.ref, p_note: "Waiting for the payout OTP", p_status: "awaiting_otp" }, outcome)
      return { status: "awaiting_otp", message: "Enter the OTP to release the payout" }
    }
    case "failed": {
      await compensate(deps, refundId, outcome.error, outcome)
      return { status: "failed", message: outcome.error }
    }
    default: {
      // Ambiguous: the money may have left. Keep the clawback in place; an admin reconciles.
      await settleRpc(deps, "mark_refund_processing", { p_refund_id: refundId, p_gateway_ref: null, p_note: outcome.error, p_status: "processing" }, outcome)
      return { status: "processing", message: `Result unknown (${outcome.error}) — use "Check status" before retrying` }
    }
  }
}

/** settle() that never lets an unexpected throw escape without parking the row for reconcile. */
async function settleSafely(deps: RefundDeps, refundId: string, outcome: GatewayOutcome): Promise<Settled> {
  try {
    return await settle(deps, refundId, outcome)
  } catch (e) {
    if (e instanceof RefundError) throw e
    await parkForReconcile(deps, refundId, refOf(outcome))
    throw new RefundError("SETTLE_FAILED", `Unexpected error while recording the payout result: ${e instanceof Error ? e.message : String(e)}`,
      { outcome: outcome.kind, ref: refOf(outcome), refundId })
  }
}

async function notifySafely(deps: RefundDeps, event: RefundNotification): Promise<void> {
  try {
    await deps.notify(event)
  } catch (e) {
    console.error("[REFUND] notification failed (non-fatal):", e)
  }
}

export interface ExecuteInput {
  table: OrderTable
  orderId: string
  gateway: string
  amount: number
  adminId: string | null
}

export async function executeRefund(deps: RefundDeps, input: ExecuteInput): Promise<{ refundId: string } & Settled> {
  const order = await deps.loadOrder(input.table, input.orderId)
  if (!order) throw new RefundError("NOT_FOUND", "Order not found")

  const elig = eligibilityOf(order)
  if (!elig.eligible) throw new RefundError("NOT_ELIGIBLE", elig.reason, { code: elig.code })

  const gateway = deps.getGateway(input.gateway)
  if (!gateway) throw new RefundError("GATEWAY_UNSUPPORTED", `Unknown gateway "${input.gateway}"`)
  const support = gateway.supports(order)
  if (!support.ok) throw new RefundError("GATEWAY_UNSUPPORTED", support.reason)

  const amountError = validateRefundAmount(input.amount, order.paid)
  if (amountError) throw new RefundError("BAD_AMOUNT", amountError)

  const destination = order.payment.payerPhone
  const { data, error } = await deps.rpc("reserve_order_refund", {
    p_order_table: input.table, p_order_id: input.orderId, p_gateway: gateway.id,
    p_paid: order.paid, p_fee: order.gatewayFee, p_amount: input.amount,
    p_destination: destination, p_wallet_user: order.payment.walletUserId, p_admin: input.adminId,
  })
  if (error) throw mapReserveError(error.message)
  if (!data || typeof data.refund_id !== "string") {
    throw new RefundError("RESERVE_FAILED", "Reserve returned no refund id", { data })
  }
  const refundId = data.refund_id as string

  const ctx: RefundContext = { refundId, order, amount: input.amount, destinationPhone: destination }
  let outcome: GatewayOutcome
  try {
    outcome = await gateway.refund(ctx)
  } catch (err) {
    console.error("[REFUND] gateway threw — treating as unknown:", err)
    outcome = { kind: "unknown", error: err instanceof Error ? err.message : "gateway error" }
  }

  const settled = await settleSafely(deps, refundId, outcome)
  if (settled.status === "completed") {
    await notifySafely(deps, { refundId, order, amount: input.amount, gateway: gateway.id, clawbacks: Array.isArray(data.clawbacks) ? data.clawbacks : [] })
  }
  return { refundId, ...settled }
}

export interface StoredRefund {
  id: string
  order_table: OrderTable
  order_id: string
  gateway: string
  amount: number
  destination_phone: string | null
  gateway_ref: string | null
  status: string
  clawbacks: RefundNotification["clawbacks"]
}

async function contextFor(deps: RefundDeps, stored: StoredRefund): Promise<RefundContext> {
  const order = await deps.loadOrder(stored.order_table, stored.order_id)
  if (!order) throw new RefundError("NOT_FOUND", "Order not found")
  return { refundId: stored.id, order, amount: Number(stored.amount), destinationPhone: stored.destination_phone }
}

async function settleStored(deps: RefundDeps, stored: StoredRefund, ctx: RefundContext, outcome: GatewayOutcome): Promise<Settled> {
  const settled = await settleSafely(deps, stored.id, outcome)
  if (settled.status === "completed") {
    await notifySafely(deps, { refundId: stored.id, order: ctx.order, amount: ctx.amount, gateway: stored.gateway, clawbacks: stored.clawbacks ?? [] })
  }
  return settled
}

/** Re-checks a refund stuck in `reserved` / `processing` / `awaiting_otp` against its gateway and settles it. */
export async function reconcileRefund(deps: RefundDeps, stored: StoredRefund): Promise<Settled> {
  if (stored.status !== "processing" && stored.status !== "awaiting_otp" && stored.status !== "reserved") {
    throw new RefundError("ORDER_NOT_PENDING", "Only processing refunds can be reconciled")
  }
  const gateway = deps.getGateway(stored.gateway)
  if (!gateway?.checkStatus) return { status: stored.status as Settled["status"], message: "This gateway cannot be re-checked automatically" }
  const ctx = await contextFor(deps, stored)
  let outcome: GatewayOutcome
  try {
    outcome = await gateway.checkStatus(ctx, stored.gateway_ref)
  } catch (err) {
    outcome = { kind: "unknown", error: err instanceof Error ? err.message : "status check failed" }
  }
  return settleStored(deps, stored, ctx, outcome)
}

const OTP_PATTERN = /^\d{4,10}$/

/** Releases an OTP-gated payout. A rejected code changes nothing: the refund stays awaiting_otp. */
export async function submitRefundOtp(deps: RefundDeps, stored: StoredRefund, otp: string): Promise<Settled> {
  if (stored.status !== "awaiting_otp" || !stored.gateway_ref) {
    throw new RefundError("ORDER_NOT_PENDING", "This refund is not waiting for an OTP")
  }
  const code = otp.trim()
  if (!OTP_PATTERN.test(code)) throw new RefundError("BAD_OTP", "Enter the numeric OTP code")
  const gateway = deps.getGateway(stored.gateway)
  if (!gateway?.finalizeOtp) throw new RefundError("GATEWAY_UNSUPPORTED", "This gateway does not use an OTP")
  const ctx = await contextFor(deps, stored)

  let outcome: GatewayOutcome
  try {
    outcome = await gateway.finalizeOtp(ctx, stored.gateway_ref, code)
  } catch (err) {
    outcome = { kind: "unknown", error: err instanceof Error ? err.message : "OTP submission failed" }
  }
  if (outcome.kind === "otp") {
    return { status: "awaiting_otp", message: "Paystack did not accept that code. Check it and try again, or cancel the refund." }
  }
  return settleStored(deps, stored, ctx, outcome)
}

/**
 * Abandons an unfinalized payout and restores the owner's clawback. Safe only if the transfer
 * did not actually go out, so the gateway is asked first: if it succeeded or is pending we
 * settle that instead of cancelling, and if we cannot confirm we refuse.
 */
export async function cancelRefund(deps: RefundDeps, stored: StoredRefund): Promise<Settled> {
  if (stored.status !== "awaiting_otp") throw new RefundError("ORDER_NOT_PENDING", "Only refunds waiting for an OTP can be cancelled")
  const gateway = deps.getGateway(stored.gateway)
  if (!gateway?.checkStatus) throw new RefundError("GATEWAY_UNSUPPORTED", "This gateway cannot confirm the payout state")
  const ctx = await contextFor(deps, stored)

  let outcome: GatewayOutcome
  try {
    outcome = await gateway.checkStatus(ctx, stored.gateway_ref)
  } catch (err) {
    outcome = { kind: "unknown", error: err instanceof Error ? err.message : "status check failed" }
  }
  if (outcome.kind === "otp" || outcome.kind === "failed") {
    await compensate(deps, stored.id, "Cancelled by admin before the payout OTP was entered", outcome)
    return { status: "failed", message: "Refund cancelled and the owner's cut restored" }
  }
  if (outcome.kind === "unknown") {
    return { status: "awaiting_otp", message: "Could not confirm the payout state with the gateway — not cancelled. Try again shortly." }
  }
  return settleStored(deps, stored, ctx, outcome)
}
