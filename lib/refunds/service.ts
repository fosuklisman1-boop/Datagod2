import type { SupabaseClient } from "@supabase/supabase-js"
import { planClawback, type ClawbackPlan } from "./clawback"
import { orderEligibility, type Eligibility } from "./eligibility"
import { defaultRefundAmount, validateRefundAmount } from "./amounts"
import { loadRefundableOrders } from "./orders"
import { getGateway, listGateways } from "./gateways"
import { notifyRefund, type RefundNotification } from "./notify"
import { loadRefundContact } from "./contact"
import { FRESH_OTP_MS, isInFlight, isStale } from "./staleness"
import { isCommissionTable, type CommissionTable, type GatewayOutcome, type OrderTable, type RefundContact, type RefundContext, type RefundGateway, type RefundableOrder } from "./types"

export const REFUND_ERROR_CODES = [
  "NOT_FOUND", "NOT_ELIGIBLE", "GATEWAY_UNSUPPORTED", "BAD_AMOUNT", "BAD_OTP", "SHORTFALL",
  "ALREADY_REFUNDED", "ORDER_NOT_PENDING", "DISPATCH_ACTIVE", "IN_FLIGHT", "RESERVE_FAILED", "SETTLE_FAILED",
  "BAD_CHANNEL",
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
  if (message.includes("ORDER_NOT_FOUND")) return new RefundError("NOT_FOUND", "Order not found")
  if (message.includes("BAD_AMOUNT")) return new RefundError("BAD_AMOUNT", "Refund amount was rejected")
  if (message.includes("BAD_TABLE")) return new RefundError("BAD_AMOUNT", "Unsupported order table")
  if (message.includes("BAD_CHANNEL")) {
    return new RefundError("BAD_CHANNEL", "Only storefront and bot (customer-paid) orders can be refunded here; wallet-paid orders use their own refund path")
  }
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
  /** Injectable clock (ms epoch) so age checks are deterministic in tests. */
  now?(): number
  /** Commission bills/bundles: SQL-guarded release of a stuck Hubtel dispatch claim (processing -> pending). Rows changed. */
  releaseStuckClaim?(table: CommissionTable, orderId: string, adminId: string | null): Promise<number>
  /** The order's non-failed refund row, if any (manual refund resume / idempotency). */
  findActiveRefund?(orderId: string): Promise<{ id: string; gateway: string; status: string } | null>
  /** Bills/bundles: record how a refunded order was refunded (refund_method). Only touches a 'refunded' row. */
  markRefundMethod?(table: CommissionTable, orderId: string, method: string): Promise<void>
  /** Durably keep the full manual-refund note on the (refunded) order's notes. Throws on DB error. */
  recordManualNote?(table: CommissionTable, orderId: string, note: string, adminId: string): Promise<void>
  /** Customer details for the manual gateway's contact card (preview only). */
  loadContact?(order: RefundableOrder): Promise<RefundContact | null>
}

const nowOf = (deps: RefundDeps): number => (deps.now ? deps.now() : Date.now())

export function defaultDeps(db: SupabaseClient): RefundDeps {
  return {
    rpc: (name, args) => db.rpc(name, args) as any,
    loadOrder: async (table, id) => (await loadRefundableOrders(db, [{ table, id }]))[0] ?? null,
    getGateway,
    notify: (e) => notifyRefund(db, e),
    loadContact: (order) => loadRefundContact(db, order),
    async releaseStuckClaim(table, orderId, adminId) {
      // The existing SQL-guarded releases (bills / standard bundles admin modules). Airtime has no Hubtel claim.
      if (table === "hubtel_bill_orders") return (await import("@/lib/bills/admin")).releaseStuckClaimRow(db, orderId, adminId ?? "unknown")
      if (table === "hubtel_data_orders") return (await import("@/lib/standard-bundles/admin")).releaseStuckClaimRow(db, orderId, adminId ?? "unknown")
      return 0
    },
    async findActiveRefund(orderId) {
      const { data, error } = await db.from("order_refunds").select("id, gateway, status").eq("order_id", orderId).neq("status", "failed").limit(1)
      if (error) throw new Error(`[REFUND] active refund lookup failed: ${error.message}`)
      const row = (data ?? [])[0] as { id: string; gateway: string; status: string } | undefined
      return row ?? null
    },
    async markRefundMethod(table, orderId, method) {
      if (table === "airtime_orders") return // no refund_method column; order_refunds.gateway records it
      const { error } = await db.from(table).update({ refund_method: method, updated_at: new Date().toISOString() }).eq("id", orderId).eq("status", "refunded")
      if (error) console.error("[REFUND] could not record refund_method (non-fatal):", error.message)
    },
    async recordManualNote(table, orderId, note, adminId) {
      const { data, error } = await db.from(table).select("notes").eq("id", orderId).maybeSingle()
      if (error) throw new Error(`[REFUND] order notes read failed: ${error.message}`)
      const previous = ((data as { notes?: string | null } | null)?.notes ?? "").trim()
      const notes = manualNoteText(note, adminId, previous)
      // Only notes change, so the refund status guard trigger lets it through.
      const { error: upErr } = await db.from(table).update({ notes, updated_at: new Date().toISOString() }).eq("id", orderId).eq("status", "refunded")
      if (upErr) throw new Error(`[REFUND] order notes write failed: ${upErr.message}`)
    },
  }
}

/** The manual note in full, prepended to the order's previous notes (which keep provider refs). */
export function manualNoteText(note: string, adminId: string, previous: string): string {
  const head = `Refunded manually by admin ${adminId}: ${note}`
  return (previous ? `${head}\n${previous}` : head).slice(0, 4000)
}

/** Releases a stuck Hubtel dispatch claim before reserving; the reserve then sees `pending`. */
async function releaseStuck(deps: RefundDeps, order: RefundableOrder, adminId: string | null): Promise<void> {
  if (!isCommissionTable(order.table) || !deps.releaseStuckClaim) {
    throw new RefundError("NOT_ELIGIBLE", "This order's dispatch claim cannot be released here")
  }
  const n = await deps.releaseStuckClaim(order.table, order.id, adminId)
  if (n === 0) throw new RefundError("NOT_ELIGIBLE", "The dispatch claim is no longer stuck; reload and retry")
}

/**
 * A reserve that fails after a stuck-claim release leaves the order `pending` again (it never reached Hubtel, so this
 * is safe, but it may now be dispatched). Say so instead of hiding it.
 */
function afterRelease(err: RefundError, released: boolean): RefundError {
  if (!released) return err
  const detail = err.detail && typeof err.detail === "object" ? { ...(err.detail as object), claimReleased: true } : { detail: err.detail, claimReleased: true }
  return new RefundError(err.code, `${err.message}. Note: the stuck dispatch claim was released, so the order is pending again and may be dispatched.`, detail)
}

const eligibilityOf = (o: RefundableOrder, now: number): Eligibility => orderEligibility(o, now)

export interface RefundPreview {
  order: RefundableOrder
  eligibility: Eligibility
  defaultAmount: number
  gateways: { id: string; label: string; ok: boolean; reason?: string }[]
  clawback: ClawbackPlan
  /** Who to pay for a manual refund; null when unknown, not applicable, or the lookup failed. */
  contact: RefundContact | null
}

async function contactOf(deps: RefundDeps, order: RefundableOrder): Promise<RefundContact | null> {
  if (!deps.loadContact) return null
  try {
    return await deps.loadContact(order)
  } catch (err) {
    console.error("[REFUND] contact lookup failed (preview continues):", err instanceof Error ? err.message : err)
    return null
  }
}

export async function previewRefund(deps: RefundDeps, ref: { table: OrderTable; id: string }): Promise<RefundPreview> {
  const order = await deps.loadOrder(ref.table, ref.id)
  if (!order) throw new RefundError("NOT_FOUND", "Order not found")
  return {
    contact: await contactOf(deps, order),
    order,
    eligibility: eligibilityOf(order, nowOf(deps)),
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
  /** Required when eligibility carries a warning (admin-overridden Hubtel failure), as for the manual path. */
  confirmOverride?: boolean
  /** Manual gateway: the admin's optional MoMo / bank reference for the money they sent. */
  manualReference?: string | null
}

export async function executeRefund(deps: RefundDeps, input: ExecuteInput): Promise<{ refundId: string } & Settled> {
  const order = await deps.loadOrder(input.table, input.orderId)
  if (!order) throw new RefundError("NOT_FOUND", "Order not found")

  const elig = eligibilityOf(order, nowOf(deps))
  if (!elig.eligible) throw new RefundError("NOT_ELIGIBLE", elig.reason, { code: elig.code })
  // An admin forced the Hubtel row to failed: Hubtel may still have delivered. No money moves without explicit confirmation.
  if (elig.warning && input.confirmOverride !== true) {
    throw new RefundError("NOT_ELIGIBLE", elig.warning, { code: "CONFIRM_REQUIRED", warning: elig.warning })
  }

  const gateway = deps.getGateway(input.gateway)
  if (!gateway) throw new RefundError("GATEWAY_UNSUPPORTED", `Unknown gateway "${input.gateway}"`)
  const support = gateway.supports(order)
  if (!support.ok) throw new RefundError("GATEWAY_UNSUPPORTED", support.reason)

  const amountError = validateRefundAmount(input.amount, order.paid)
  if (amountError) throw new RefundError("BAD_AMOUNT", amountError)

  if (elig.releaseStuck) await releaseStuck(deps, order, input.adminId)

  const destination = order.payment.payerPhone
  const { data, error } = await deps.rpc("reserve_order_refund", {
    p_order_table: input.table, p_order_id: input.orderId, p_gateway: gateway.id,
    p_paid: order.paid, p_fee: order.gatewayFee, p_amount: input.amount,
    p_destination: destination, p_wallet_user: order.payment.walletUserId, p_admin: input.adminId,
    // No claims row => 0: a dispatch that claims after this read changes the count and the reserve refuses.
    p_expected_attempts: order.evidence.dispatchAttempts ?? 0,
  })
  if (error) throw afterRelease(mapReserveError(error.message), !!elig.releaseStuck)
  if (!data || typeof data.refund_id !== "string") {
    throw afterRelease(new RefundError("RESERVE_FAILED", "Reserve returned no refund id", { data }), !!elig.releaseStuck)
  }
  const refundId = data.refund_id as string

  const ctx: RefundContext = { refundId, order, amount: input.amount, destinationPhone: destination, manualReference: input.manualReference ?? null }
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
  updated_at: string
  created_at?: string
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
  if (isInFlight(stored, nowOf(deps))) {
    throw new RefundError("IN_FLIGHT", "The original payout request may still be running. Wait a few minutes before checking status.")
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
  if (!isStale(stored.updated_at, nowOf(deps), FRESH_OTP_MS)) {
    throw new RefundError("IN_FLIGHT", "This payout was only just created. Wait a minute before cancelling.")
  }
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

export const MANUAL_GATEWAY = "manual"

export interface ManualRefundInput {
  table: OrderTable
  orderId: string
  /** Required admin note (validated by the route, <= 500 chars). */
  note: string
  adminId: string
  /** Required when eligibility carries a warning (admin-overridden Hubtel failure). */
  confirmOverride?: boolean
}

export interface ManualRefundResult {
  refundId: string | null
  status: "completed"
  /** true => nothing changed: the order was already refunded (second click). */
  alreadyRefunded: boolean
  message: string
}

const manualRef = (note: string) => `manual: ${note}`.slice(0, 200)

/** Completes the manual refund; returns false when the full note could not be stored on the order (refund still done). */
async function completeManual(deps: RefundDeps, order: RefundableOrder, refundId: string, note: string, adminId: string): Promise<boolean> {
  const { data, error } = await callRpc(deps, "complete_order_refund", { p_refund_id: refundId, p_gateway_ref: manualRef(note) })
  if (error || data !== "completed") {
    throw new RefundError(
      "SETTLE_FAILED",
      `The manual refund was reserved (owner's cut already removed) but could not be marked completed (${error?.message ?? `ledger says ${String(data)}`}). Click "Mark refunded manually" again to finish it.`,
      { refundId, rpc: "complete_order_refund", ledgerStatus: data ?? null },
    )
  }
  if (deps.markRefundMethod && isCommissionTable(order.table)) {
    try { await deps.markRefundMethod(order.table, order.id, MANUAL_GATEWAY) } catch (e) { console.error("[REFUND] refund_method write failed (non-fatal):", e) }
  }
  if (deps.recordManualNote && isCommissionTable(order.table)) {
    try {
      await deps.recordManualNote(order.table, order.id, note, adminId)
    } catch (e) {
      console.error("[REFUND] manual note write failed:", e)
      return false
    }
  }
  return true
}

const NOTE_NOT_SAVED = " The note could not be saved on the order; it is in the admin audit log."

/**
 * "Mark refunded manually" for a storefront commission order: the admin refunded the customer outside our gateways.
 * No money moves here. Same eligibility as a gateway refund (never while Hubtel may still deliver); then the refund
 * ledger records it exactly like a gateway refund — reserve_order_refund (guarded status flip under the order lock +
 * the shop-share clawback), then complete_order_refund (order -> refunded; bills/bundles payment_status refunded) —
 * with gateway 'manual'. Idempotent: an already-refunded order is a no-op, a reserved-but-unfinished manual refund is
 * completed, and the RPC's one-active-refund guard stops a concurrent double click from clawing back twice.
 */
export async function executeManualRefund(deps: RefundDeps, input: ManualRefundInput): Promise<ManualRefundResult> {
  if (!isCommissionTable(input.table)) {
    throw new RefundError("GATEWAY_UNSUPPORTED", "Manual refunds are only for storefront airtime, bill and bundle orders and bot bill and bundle orders")
  }
  const order = await deps.loadOrder(input.table, input.orderId)
  if (!order) throw new RefundError("NOT_FOUND", "Order not found")
  if (!order.evidence.commission?.storefront) {
    throw new RefundError("NOT_ELIGIBLE", "Not a storefront or bot order — refund it through its own refund path", { code: "NOT_STOREFRONT" })
  }
  const already = (): ManualRefundResult => ({ refundId: null, status: "completed", alreadyRefunded: true, message: "This order is already refunded; nothing changed" })
  if (order.orderStatus === "refunded") return already()

  if (order.evidence.hasActiveRefund) {
    const active = deps.findActiveRefund ? await deps.findActiveRefund(order.id) : null
    if (active && active.gateway === MANUAL_GATEWAY && active.status === "reserved") {
      const saved = await completeManual(deps, order, active.id, input.note, input.adminId)
      // The clawback lines are on the stored refund row; the customer notice needs none.
      await notifySafely(deps, { refundId: active.id, order, amount: order.paid, gateway: MANUAL_GATEWAY, clawbacks: [] })
      return { refundId: active.id, status: "completed", alreadyRefunded: false, message: `Manual refund completed.${saved ? "" : NOTE_NOT_SAVED}` }
    }
    throw new RefundError("ALREADY_REFUNDED", "A refund is already in progress for this order — see History")
  }

  const elig = eligibilityOf(order, nowOf(deps))
  if (!elig.eligible) throw new RefundError("NOT_ELIGIBLE", elig.reason, { code: elig.code })
  if (elig.warning && input.confirmOverride !== true) {
    throw new RefundError("NOT_ELIGIBLE", elig.warning, { code: "CONFIRM_REQUIRED", warning: elig.warning })
  }
  if (elig.releaseStuck) await releaseStuck(deps, order, input.adminId)

  const { data, error } = await deps.rpc("reserve_order_refund", {
    p_order_table: input.table, p_order_id: input.orderId, p_gateway: MANUAL_GATEWAY,
    // Exactly what the customer paid (total_paid / paid_amount): the RPC does not cross-check it.
    p_paid: order.paid, p_fee: 0, p_amount: order.paid,
    p_destination: null, p_wallet_user: null, p_admin: input.adminId,
    p_expected_attempts: order.evidence.dispatchAttempts ?? 0,
  })
  if (error) {
    const mapped = mapReserveError(error.message)
    if (mapped.code === "ALREADY_REFUNDED" || mapped.code === "ORDER_NOT_PENDING") {
      // A concurrent click won the race: if it finished, this click is a no-op.
      const fresh = await deps.loadOrder(input.table, input.orderId)
      if (fresh?.orderStatus === "refunded") return already()
    }
    throw afterRelease(mapped, !!elig.releaseStuck)
  }
  if (!data || typeof data.refund_id !== "string") {
    throw afterRelease(new RefundError("RESERVE_FAILED", "Reserve returned no refund id", { data }), !!elig.releaseStuck)
  }
  const refundId = data.refund_id as string
  const saved = await completeManual(deps, order, refundId, input.note, input.adminId)
  const clawbacks = Array.isArray(data.clawbacks) ? data.clawbacks : []
  await notifySafely(deps, { refundId, order, amount: order.paid, gateway: MANUAL_GATEWAY, clawbacks })
  // A main-bot order has no shop share: say so instead of claiming a clawback.
  const head = clawbacks.length === 0 && order.owners.length === 0 ? "Marked refunded (no shop share to claw back)." : "Marked refunded; the shop's share was clawed back."
  return { refundId, status: "completed", alreadyRefunded: false, message: `${head}${saved ? "" : NOTE_NOT_SAVED}` }
}
