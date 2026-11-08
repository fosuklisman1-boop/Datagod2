// lib/ussd-hubtel/flows/pay-choice.ts
// Wallet or MoMo, on the main code only. A service's confirm runs its replay check, then checkoutOrChoose: an
// eligible caller (switch on, main mode, Platform USSD, the dialler resolves to an account whose balance covers the
// price) sees PAY_CHOICE; everyone else goes to Hubtel's checkout exactly as before.
//
// On PAY_CHOICE, 1 and 2 both run the replay check, then the service's prepare again (price, stock, recipient block),
// so nothing is charged on a stale screen. 1 creates the order with no hubtel_transactions row and debits the wallet
// through payFromWallet; 2 is today's submitOrder. Logs carry ids and amounts only, never a phone.
import { findWalletPaymentBySession, payFromWallet, runWalletPostPayment, WALLET_SOURCE, type WalletTable } from "../wallet-pay"
import {
  createOrderRow, failOrderGuarded, finish, goto, ORDER_ERROR_TEXT, replaySubmittedOrder, say, submitOrder,
  UNAVAILABLE_TEXT, type FlowCtx, type StepHandler, type SubmitNewOrder,
} from "../flow-kit"
import { safeDbError } from "../log-safe"
import type { HubtelReply, PayKind } from "../types"

const LOG = "[HUBTEL-WALLET-PAY]"
const CHOICE = { label: "Pay with" }

/** The order a service would create: every check has passed, nothing is written yet. */
export type PreparedOrder = SubmitNewOrder
/** A service's confirm checks, re-run at the moment of paying. A reply means stop and show it (nothing was created). */
export type Prepare = (ctx: FlowCtx) => Promise<PreparedOrder | HubtelReply>

export const INSUFFICIENT_TEXT = "Insufficient balance.\n2. MoMo\n0. Cancel"

export function choiceScreenText(balance: number): string {
  return `Pay with:\n1. Datagod Wallet\n   (bal GHS ${balance.toFixed(2)})\n2. MoMo\n0. Cancel`
}

/** The final screen after a wallet payment: "Payment successful." plus the service's delivery wording (Uzo's). */
const PAID_TEXT: Partial<Record<PayKind, (row: Record<string, unknown>) => string>> = {
  data: () => "Payment successful.\nYour package will reflect\nin a few minutes.",
  airtime: () => "Payment successful.\nAirtime will reflect\nshortly.",
  // Uzo's wallet text, in future tense: here the vouchers are assigned after the debit (deferred post-payment), so "sent" would promise too early.
  rc: row => `Success! Ref ${String(row.reference_code ?? "")}.\nYour ${String(row.exam_board ?? "")} voucher${Number(row.quantity) > 1 ? "s" : ""} will be\nsent by SMS shortly.`,
  rc_check: row => `Payment successful!\nWe'll check your\n${String(row.exam_board ?? "")} results and\nsend them to you shortly.`,
}
const paidText = (kind: PayKind, row: Record<string, unknown>) => PAID_TEXT[kind]?.(row) ?? "Payment successful."

/** The wallet history line, as Uzo writes it, minus any phone number. */
const DESCRIPTION: Partial<Record<PayKind, (row: Record<string, unknown>) => string>> = {
  data: row => `USSD data purchase: ${String(row.network ?? "")} ${String(row.package_size ?? "")}`.trim(),
  airtime: row => `Airtime: ${String(row.network ?? "")} GHS ${Number(row.airtime_amount).toFixed(2)}`.trim(),
  rc: row => `${String(row.exam_board ?? "")} Results Checker x${String(row.quantity ?? "")} — Ref: ${String(row.reference_code ?? "")}`,
  rc_check: row => `Results check: ${String(row.exam_board ?? "")} ${String(row.index_number ?? "")} ${String(row.exam_year ?? "")}`,
}
const descriptionFor = (kind: PayKind, row: Record<string, unknown>) => DESCRIPTION[kind]?.(row) ?? "USSD purchase"

/** The order row's money column per wallet table: set to the debited amount on the wallet path. */
const AMOUNT_COLUMN: Partial<Record<WalletTable, string>> = {
  ussd_orders: "amount",
  airtime_orders: "total_paid", // fee-priced: the typed amount; cashback: cb.payAmount (cashbackAirtimeColumns)
  results_checker_orders: "total_paid",
  results_check_requests: "fee",
}

const ALREADY_SUBMITTED_TEXT = "This order was already submitted."

function isWalletTable(table: string): table is WalletTable {
  return Object.prototype.hasOwnProperty.call(WALLET_SOURCE, table)
}

function isReply(x: PreparedOrder | HubtelReply): x is HubtelReply {
  return typeof (x as HubtelReply).Type === "string" && typeof (x as HubtelReply).SessionId === "string"
}

/** Whole pesewas, so the RPC never sees float noise (it refuses more than 2 decimals). */
const pesewas = (n: number) => Math.round(n * 100)

/** Switch on, main mode (a missing mode is main), Platform USSD, and the wallet deps wired. Reads nothing. */
function walletOpen(ctx: FlowCtx): boolean {
  return ctx.config.walletPayment === true
    && ctx.session.mode !== "shop"
    && ctx.req.Platform === "USSD"
    && typeof ctx.deps.walletPayDeps === "function"
}

/**
 * The wallet offer for this caller at `price`, or null: not eligible, unregistered, balance short, or the balance
 * could not be read (then the caller simply goes to the checkout). With the switch off nothing is read.
 */
export async function walletOfferFor(ctx: FlowCtx, price: number): Promise<{ userId: string; balance: number } | null> {
  if (!walletOpen(ctx)) return null
  if (!(Number.isFinite(price) && price > 0)) return null
  try {
    const dialer = await ctx.deps.resolveDialer(ctx.session.dialingPhone)
    const balance = Number(dialer.balance)
    if (!dialer.userId || !Number.isFinite(balance)) return null
    if (pesewas(balance) < pesewas(price)) return null
    return { userId: dialer.userId, balance }
  } catch (e) {
    console.warn(LOG, "balance read failed; going to checkout:", ctx.req.SessionId, safeDbError(e))
    return null
  }
}

/** Called from a service's confirm after its replay check: the choice screen when eligible, else today's checkout. */
export async function checkoutOrChoose(ctx: FlowCtx, kind: PayKind, prepare: Prepare): Promise<HubtelReply> {
  const prepared = await prepare(ctx)
  if (isReply(prepared)) return prepared
  const offer = isWalletTable(prepared.table) ? await walletOfferFor(ctx, prepared.price) : null
  if (!offer) return submitOrder(ctx, prepared)
  return goto(ctx, { step: "PAY_CHOICE", payKind: kind, payBalance: offer.balance, payWalletDeclined: false }, choiceScreenText(offer.balance), CHOICE)
}

function repaint(ctx: FlowCtx): HubtelReply {
  const text = ctx.session.payWalletDeclined ? INSUFFICIENT_TEXT : choiceScreenText(ctx.session.payBalance ?? 0)
  return say(ctx, text, "PAY_CHOICE", CHOICE)
}

/** 2: today's checkout, after the replay check and the service's checks again. */
async function payByCheckout(ctx: FlowCtx, prepare: Prepare): Promise<HubtelReply> {
  const replay = await replaySubmittedOrder(ctx.deps, ctx.req.SessionId, ctx.req.Platform)
  if (replay) return replay
  const prepared = await prepare(ctx)
  if (isReply(prepared)) return prepared
  return submitOrder(ctx, prepared)
}

/** 1: create the order, debit the wallet once, then run the order's own post-payment step. */
async function payByWallet(ctx: FlowCtx, kind: PayKind, prepare: Prepare): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  const sid = req.SessionId

  const replay = await replaySubmittedOrder(deps, sid, req.Platform)
  if (replay) return replay

  // The switch may have been turned off while the screen was showing: nothing is created or debited.
  if (!walletOpen(ctx)) {
    console.warn(LOG, "wallet no longer available on PAY_CHOICE; nothing created:", sid)
    return finish(ctx, UNAVAILABLE_TEXT)
  }

  const prepared = await prepare(ctx)
  if (isReply(prepared)) return prepared
  const table = prepared.table
  if (!isWalletTable(table)) {
    console.error(LOG, "order table cannot be paid from the wallet; nothing created:", table, sid)
    return finish(ctx, UNAVAILABLE_TEXT)
  }
  const cents = pesewas(prepared.price)
  if (!(Number.isSafeInteger(cents) && cents > 0)) {
    console.error(LOG, "refusing a non-positive price:", prepared.price, sid)
    return finish(ctx, UNAVAILABLE_TEXT)
  }
  const amount = cents / 100

  let userId: string | undefined
  try {
    userId = (await deps.resolveDialer(session.dialingPhone)).userId
  } catch (e) {
    console.warn(LOG, "dialer read failed on PAY_CHOICE; nothing created:", sid, safeDbError(e))
  }
  if (!userId) return finish(ctx, UNAVAILABLE_TEXT)

  const walletDeps = deps.walletPayDeps!()
  // The row records exactly what is debited (the MoMo path keeps prepare's value as before).
  const row = { ...prepared.row }
  const amountColumn = AMOUNT_COLUMN[table]
  if (amountColumn && typeof row[amountColumn] === "number") row[amountColumn] = amount
  const order = await createOrderRow(ctx, { ...prepared, row })
  if (!order) return finish(ctx, ORDER_ERROR_TEXT)

  const result = await payFromWallet(walletDeps, {
    sessionId: sid, userId, table, orderId: order.id, amount, description: descriptionFor(kind, prepared.row),
  })
  // Guarded on the table's payable statuses (`engine` = true): a paid order is never failed from here.
  const failOrder = () => failOrderGuarded(deps.supabase, table, order.id, true, prepared.logTag)
  /**
   * After failing this request's order: a concurrent request for this session may have paid (its own order). Then
   * the customer was debited once and will be served, so say so. A read error keeps the unavailable text.
   */
  const unavailableOrAlreadyPaid = async () => {
    try {
      if (await findWalletPaymentBySession(deps.supabase, sid)) {
        console.warn(LOG, "another request paid this session; this order failed:", table, order.id, sid)
        return finish(ctx, ALREADY_SUBMITTED_TEXT)
      }
    } catch (e) {
      console.error(LOG, "payment re-read failed after a refusal:", table, order.id, sid, safeDbError(e))
    }
    return finish(ctx, UNAVAILABLE_TEXT)
  }

  switch (result.kind) {
    case "paid": {
      console.info(LOG, "paid from wallet:", table, order.id, amount, sid)
      const paymentId = result.paymentId
      if (paymentId) {
        const post = () => runWalletPostPayment(walletDeps, paymentId, table, order.id, amount)
        if (deps.defer) deps.defer(post)
        else await post()
      } else {
        // Not expected (payFromWallet always names the payment): the row is debited, so the sweep runs it.
        console.error(LOG, "paid with no payment id; left for the sweep:", table, order.id, sid)
      }
      return finish(ctx, paidText(kind, row))
    }
    case "replay":
      // This session's payment already exists for this order: the run that made it owns post-payment.
      console.warn(LOG, "wallet payment replayed:", table, order.id, sid)
      return finish(ctx, paidText(kind, row))
    case "insufficient":
      await failOrder()
      return goto(ctx, { step: "PAY_CHOICE", payWalletDeclined: true }, INSUFFICIENT_TEXT, CHOICE)
    case "refused":
      await failOrder()
      return unavailableOrAlreadyPaid()
    case "unavailable":
    default:
      if (result.debitUncertain) {
        // A debit may exist: the sweep owns this order. Failing it here could hide a paid order.
        console.error(LOG, "debit uncertain; order left for the sweep:", table, order.id, amount, sid)
        return finish(ctx, UNAVAILABLE_TEXT)
      }
      // No payment row: fail it. A debit committing late then finds the order failed and is held for review.
      await failOrder()
      return unavailableOrAlreadyPaid()
  }
}

/** The PAY_CHOICE step. `prepares` comes from router.ts (no import cycle): one per service kind. */
export function payChoiceStep(prepares: Partial<Record<PayKind, Prepare>>): StepHandler {
  return async ctx => {
    const { input, session } = ctx
    if (input === "0") return finish(ctx, "Order cancelled.")
    if (input !== "1" && input !== "2") return repaint(ctx)
    if (input === "1" && session.payWalletDeclined) return repaint(ctx)
    const kind = session.payKind
    const prepare = kind ? prepares[kind] : undefined
    if (!kind || !prepare) {
      console.error(LOG, "PAY_CHOICE with no prepare for its kind; nothing created:", kind ?? "none", ctx.req.SessionId)
      return finish(ctx, UNAVAILABLE_TEXT)
    }
    return input === "2" ? payByCheckout(ctx, prepare) : payByWallet(ctx, kind, prepare)
  }
}
