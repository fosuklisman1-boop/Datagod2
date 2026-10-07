// lib/ussd-hubtel/flows/rc-buy.ts
// Results Checker on the Hubtel channel: sub-menu, buy vouchers, my vouchers, resend. Port of
// lib/ussd/handlers/results-checker.ts lines 39-421 minus wallet, Paystack and OTP.
import { secureReference } from "@/lib/secure-random"
import type { ExamBoard } from "@/lib/results-check-validation"
import { rcMenuText } from "../menus"
import { toLocalPhone } from "../protocol"
import { safeDbError } from "../log-safe"
import { startRcCheck } from "./rc-check"
import { backToMain, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { MyVoucherOrder } from "../services"
import type { HubtelReply } from "../types"

export const ALL_BOARDS: ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]

const MENU = { label: "Results Checker" }
const BOARD = { label: "Select exam" }
const QTY = { label: "Quantity", fieldType: "number" as const }
const CONFIRM = { label: "Confirm vouchers" }
const MINE = { label: "My vouchers" }
const DETAIL = { label: "Voucher" }

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })

export function rcBoardMenuText(boards: string[]): string {
  return "Buy Results Checker\nSelect exam:\n" + boards.map((b, i) => `${i + 1}. ${b}`).join("\n") + "\n0. Back"
}

export function rcQtyPromptText(board: string, available: number, max: number, bulk: { minQty: number; unitPrice: number } | null): string {
  const cap = Math.min(available, max)
  const hint = bulk ? `\nBuy ${bulk.minQty}+ for GHS ${bulk.unitPrice.toFixed(2)} each` : ""
  return `${board} Checker\nHow many vouchers?\n(1 - ${cap}):${hint}\n0. Back`
}

export function rcConfirmText(board: string, qty: number, total: number, payerLocal: string, bulkUnit: number | null): string {
  const bulk = bulkUnit != null ? `\nBulk rate GHS ${bulkUnit.toFixed(2)} each` : ""
  return `Confirm Vouchers\n${board} x ${qty}${bulk}\nGHS ${total.toFixed(2)} from ${payerLocal}\nPIN(s) sent by SMS\n1. Pay now\n2. Cancel`
}

export function rcMyVouchersText(orders: MyVoucherOrder[]): string {
  if (orders.length === 0) return "No completed vouchers\nfor this number.\n0. Back"
  return "My Vouchers\n" + orders.map((o, i) => `${i + 1}. ${o.exam_board} ${o.reference_code} (${shortDate(o.created_at)})`).join("\n") + "\n0. Back"
}

export function rcVoucherDetailText(o: MyVoucherOrder): string {
  return `${o.exam_board} ${o.reference_code}\nBought ${shortDate(o.created_at)}\n1. Resend SMS\n0. Back`
}

export async function startRc(ctx: FlowCtx): Promise<HubtelReply> {
  return goto(ctx, { step: "RC_MENU" }, rcMenuText(), MENU)
}

const toRcMenu = (ctx: FlowCtx, prefix = "") => goto(ctx, { step: "RC_MENU" }, prefix + rcMenuText(), MENU)

/** Boards that are enabled AND in stock, in fixed order (Uzo buildRcBoardOptions). */
async function boardOptions(ctx: FlowCtx): Promise<ExamBoard[]> {
  const rc = ctx.deps.rc
  const picks = await Promise.all(ALL_BOARDS.map(async b => ((await rc.isBoardEnabled(b)) && (await rc.availableCount(b)) > 0 ? b : null)))
  return picks.filter((b): b is ExamBoard => b !== null)
}

async function qtyScreen(ctx: FlowCtx, board: ExamBoard) {
  const [available, max, hint] = await Promise.all([ctx.deps.rc.availableCount(board), ctx.deps.rc.maxQuantity(), ctx.deps.rc.bulkHint(board)])
  return {
    available,
    max,
    text: rcQtyPromptText(board, available, max, hint ? { minQty: hint.minQty, unitPrice: hint.bulkBasePrice } : null),
  }
}

async function rcMenu(ctx: FlowCtx): Promise<HubtelReply> {
  switch (ctx.input) {
    case "0":
      return backToMain(ctx)
    case "1": {
      const boards = await boardOptions(ctx)
      if (boards.length === 0) return say(ctx, "No vouchers available right now.\n" + rcMenuText(), "RC_MENU", MENU)
      return goto(ctx, { step: "RC_SELECT_BOARD", rcBoardOptions: boards }, rcBoardMenuText(boards), BOARD)
    }
    case "2": {
      const orders = await ctx.deps.rc.listMyVouchers(ctx.session.dialingPhone)
      return goto(ctx, { step: "RC_MY_VOUCHERS", rcMyOrders: orders }, rcMyVouchersText(orders), MINE)
    }
    case "3":
      return startRcCheck(ctx)
    default:
      return say(ctx, rcMenuText(), "RC_MENU", MENU)
  }
}

async function selectBoard(ctx: FlowCtx): Promise<HubtelReply> {
  const options = (ctx.session.rcBoardOptions ?? []) as ExamBoard[]
  if (ctx.input === "0") return toRcMenu(ctx)
  const board = /^\d+$/.test(ctx.input) ? options[Number(ctx.input) - 1] : undefined
  if (!board) return say(ctx, rcBoardMenuText(options), "RC_SELECT_BOARD", BOARD)
  const { text } = await qtyScreen(ctx, board)
  return goto(ctx, { step: "RC_ENTER_QTY", rcBoard: board }, text, QTY)
}

async function enterQty(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, session } = ctx
  const board = session.rcBoard as ExamBoard
  if (ctx.input === "0") return goto(ctx, { step: "RC_SELECT_BOARD" }, rcBoardMenuText(session.rcBoardOptions ?? []), BOARD)

  const { available, max, text } = await qtyScreen(ctx, board)
  const cap = Math.min(available, max)
  if (!(cap >= 1)) return toRcMenu(ctx, `${board} vouchers are sold out.\n`)
  const qty = /^\d+$/.test(ctx.input) ? Number(ctx.input) : NaN
  if (!(qty >= 1 && qty <= cap)) return say(ctx, "Enter a valid quantity.\n" + text, "RC_ENTER_QTY", QTY)

  const pricing = await deps.rc.price(board, qty, true)
  return goto(ctx, {
    step: "RC_CONFIRM", rcQty: qty, rcUnitPrice: pricing.unitPrice, rcTotal: pricing.totalPaid, rcBulkApplied: pricing.bulkApplied,
  }, rcConfirmText(board, qty, pricing.totalPaid, toLocalPhone(session.dialingPhone), pricing.bulkApplied ? pricing.unitPrice : null), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  const board = session.rcBoard as ExamBoard
  const qty = session.rcQty!
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  if (ctx.input !== "1") {
    return say(ctx, rcConfirmText(board, qty, session.rcTotal!, toLocalPhone(session.dialingPhone), session.rcBulkApplied ? session.rcUnitPrice! : null), "RC_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Stale-session guard: stock and price may have moved since the confirm screen. Every
  // comparison is written so NaN / undefined fails closed (releases) rather than selling.
  const [enabled, available] = await Promise.all([deps.rc.isBoardEnabled(board), deps.rc.availableCount(board)])
  if (enabled !== true || !(available >= qty)) {
    return finish(ctx, `${board} vouchers are no longer available in that quantity. Please try again.`)
  }
  const pricing = await deps.rc.price(board, qty, true)
  if (!(Math.abs(pricing.totalPaid - session.rcTotal!) <= 0.001)) {
    const shown = Number.isFinite(pricing.totalPaid) ? ` to GHS ${pricing.totalPaid.toFixed(2)}` : ""
    return finish(ctx, `Price changed${shown}. Please restart your order.`)
  }
  const dialer = await deps.resolveDialer(session.dialingPhone)

  return submitOrder(ctx, {
    table: "results_checker_orders",
    price: pricing.totalPaid,
    logTag: "HUBTEL-RC",
    row: {
      reference_code: secureReference("RC", 2, 3),
      exam_board: board,
      quantity: qty,
      customer_name: "USSD Customer",
      customer_email: dialer.email ?? null,
      customer_phone: toLocalPhone(session.dialingPhone), // the PINs are SMSed here after payment
      unit_price: pricing.unitPrice,
      fee_amount: 0,
      total_paid: pricing.totalPaid, // our price; Hubtel adds its own charge on top, at Hubtel
      shop_id: null,
      merchant_commission: 0,
      user_id: dialer.userId ?? null,
      status: "pending_payment",
      payment_status: "pending_payment",
      dialing_phone: session.dialingPhone,
      channel: "ussd",
    },
  })
}

async function myVouchers(ctx: FlowCtx): Promise<HubtelReply> {
  const orders = ctx.session.rcMyOrders ?? []
  if (ctx.input === "0") return toRcMenu(ctx)
  const o = /^\d+$/.test(ctx.input) ? orders[Number(ctx.input) - 1] : undefined
  if (!o) return say(ctx, rcMyVouchersText(orders), "RC_MY_VOUCHERS", MINE)
  return goto(ctx, { step: "RC_VOUCHER_DETAIL", rcSelectedOrderId: o.id }, rcVoucherDetailText(o), DETAIL)
}

async function voucherDetail(ctx: FlowCtx): Promise<HubtelReply> {
  const orders = ctx.session.rcMyOrders ?? []
  const o = orders.find(x => x.id === ctx.session.rcSelectedOrderId)
  if (ctx.input === "0" || !o) return goto(ctx, { step: "RC_MY_VOUCHERS" }, rcMyVouchersText(orders), MINE)
  if (ctx.input !== "1") return say(ctx, rcVoucherDetailText(o), "RC_VOUCHER_DETAIL", DETAIL)
  try {
    const result = await ctx.deps.rc.resendVouchers(o.id)
    if (!result.success) return finish(ctx, result.message.length < 100 ? result.message : "Resend failed. Please contact support.")
  } catch (e) {
    console.error("[HUBTEL-RC] resend failed:", o.id, safeDbError(e))
    return finish(ctx, "Resend failed. Please contact support.")
  }
  // Sent to the order's own customer_phone (which may not be this caller), so do not name a number.
  return finish(ctx, "Vouchers resent by SMS to the number on the order.")
}

export const RC_BUY_STEPS: StepTable = {
  RC_MENU: rcMenu,
  RC_SELECT_BOARD: selectBoard,
  RC_ENTER_QTY: enterQty,
  RC_CONFIRM: confirm,
  RC_MY_VOUCHERS: myVouchers,
  RC_VOUCHER_DETAIL: voucherDetail,
}
