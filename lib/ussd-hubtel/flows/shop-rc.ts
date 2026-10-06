// lib/ussd-hubtel/flows/shop-rc.ts
// Shop-mode results-checker vouchers. Port of lib/ussd-shop/handlers/results-checker.ts minus
// Paystack and OTP: board -> quantity -> confirm (no sub-menu, no My Vouchers, no Check Results,
// exactly what the Uzo shop offers, D13). Price = calculateRCPrice with the shop's markup (bulk base
// when the threshold is met) via deps.shop.rcPrice; markup x qty is the shop's merchant_commission,
// credited to shop_id by fulfillPaidResultsCheckerOrder on delivery (Plan 2's results_checker_orders
// handler verifies that credit). The shop token was billed at the code step: nothing is billed here.
import type { ExamBoard } from "@/lib/results-check-validation"
import { secureReference } from "@/lib/secure-random"
import { shopHeader } from "../menus"
import { toLocalPhone } from "../protocol"
import { finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import { ALL_BOARDS } from "./rc-buy"
import { backToProduct, shopMenuReply } from "./shop"
import type { HubtelReply } from "../types"

const BOARD = { label: "Select exam" }
const QTY = { label: "Quantity", fieldType: "number" as const }
const CONFIRM = { label: "Confirm vouchers" }
const UNAVAILABLE = "Results Checker unavailable.\n"

export function shopRcBoardText(shopName: string, boards: string[]): string {
  return `${shopHeader(shopName)}\nSelect exam:\n` + boards.map((b, i) => `${i + 1}. ${b}`).join("\n") + "\n0. Back"
}

export function shopRcQtyText(board: string, available: number, max: number, bulk: { minQty: number; unitPrice: number } | null): string {
  const cap = Math.min(available, max)
  const hint = bulk ? `\nBuy ${bulk.minQty}+ for GHS ${bulk.unitPrice.toFixed(2)} each` : ""
  return `${board} Checker\nHow many vouchers?\n(1 - ${cap}):${hint}\n0. Back`
}

export function shopRcConfirmText(shopName: string, board: string, qty: number, total: number, payerLocal: string, bulkUnit: number | null): string {
  const bulk = bulkUnit != null ? `\nBulk rate GHS ${bulkUnit.toFixed(2)} each` : ""
  return `${shopHeader(shopName)}\n${board} x ${qty}${bulk}\nGHS ${total.toFixed(2)} from ${payerLocal}\nPIN(s) sent by SMS\n1. Pay now\n2. Cancel`
}

const nameOf = (ctx: FlowCtx) => ctx.session.shopName ?? "Shop"
const isBoard = (b: unknown): b is ExamBoard => typeof b === "string" && (ALL_BOARDS as string[]).includes(b)

type ShopRcPricing = { unitPrice: number; totalPaid: number; bulkApplied: boolean; merchantCommission: number }

/** A price is usable only when every money part is a finite number and the total is positive (fail closed). */
function usablePricing(p: ShopRcPricing): boolean {
  return Number.isFinite(p.unitPrice) && p.unitPrice > 0
    && Number.isFinite(p.totalPaid) && p.totalPaid > 0
    && Number.isFinite(p.merchantCommission) && p.merchantCommission >= 0
}

/** Boards that are enabled AND in stock, fixed order (Uzo buildRcBoardOptions). */
async function boardOptions(ctx: FlowCtx): Promise<ExamBoard[]> {
  const rc = ctx.deps.rc
  const picks = await Promise.all(ALL_BOARDS.map(async b => ((await rc.isBoardEnabled(b)) && (await rc.availableCount(b)) > 0 ? b : null)))
  return picks.filter((b): b is ExamBoard => b !== null)
}

/** Quantity screen; the bulk hint shows the SHOP's unit price at the threshold (Uzo shop). */
async function qtyScreen(ctx: FlowCtx, board: ExamBoard, shopId: string) {
  const rc = ctx.deps.rc
  const [available, max, hint] = await Promise.all([rc.availableCount(board), rc.maxQuantity(), rc.bulkHint(board)])
  let bulk: { minQty: number; unitPrice: number } | null = null
  if (hint) {
    const atThreshold = await ctx.deps.shop.rcPrice(board, hint.minQty, shopId)
    if (atThreshold.bulkApplied && Number.isFinite(atThreshold.unitPrice)) bulk = { minQty: hint.minQty, unitPrice: atThreshold.unitPrice }
  }
  return { available, max, text: shopRcQtyText(board, available, max, bulk) }
}

export async function startShopRc(ctx: FlowCtx): Promise<HubtelReply> {
  const boards = await boardOptions(ctx)
  if (boards.length === 0) return shopMenuReply(ctx, UNAVAILABLE)
  return goto(ctx, { step: "SHOP_RC_SELECT_BOARD", rcBoardOptions: boards }, shopRcBoardText(nameOf(ctx), boards), BOARD)
}

async function selectBoard(ctx: FlowCtx): Promise<HubtelReply> {
  const options = (ctx.session.rcBoardOptions ?? []).filter(isBoard)
  if (ctx.input === "0") return backToProduct(ctx)
  const shopId = ctx.session.shopId
  if (!shopId) return backToProduct(ctx, UNAVAILABLE)
  const board = /^\d+$/.test(ctx.input) ? options[Number(ctx.input) - 1] : undefined
  if (!board) return say(ctx, shopRcBoardText(nameOf(ctx), options), "SHOP_RC_SELECT_BOARD", BOARD)
  const { text } = await qtyScreen(ctx, board, shopId)
  return goto(ctx, { step: "SHOP_RC_ENTER_QTY", rcBoard: board }, text, QTY)
}

async function enterQty(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, session } = ctx
  if (ctx.input === "0") {
    // Re-read: stock and enabled boards may have changed since the list was shown (Uzo).
    const boards = await boardOptions(ctx)
    if (boards.length === 0) return backToProduct(ctx, UNAVAILABLE)
    return goto(ctx, { step: "SHOP_RC_SELECT_BOARD", rcBoardOptions: boards }, shopRcBoardText(nameOf(ctx), boards), BOARD)
  }
  const board = session.rcBoard
  const shopId = session.shopId
  if (!isBoard(board) || !shopId) return backToProduct(ctx, UNAVAILABLE)

  const { available, max, text } = await qtyScreen(ctx, board, shopId)
  const cap = Math.min(available, max)
  if (!(cap >= 1)) return backToProduct(ctx, `${board} vouchers are sold out.\n`)
  const qty = /^\d+$/.test(ctx.input) ? Number(ctx.input) : NaN
  if (!(qty >= 1 && qty <= cap)) return say(ctx, "Enter a valid quantity.\n" + text, "SHOP_RC_ENTER_QTY", QTY)

  const pricing = await deps.shop.rcPrice(board, qty, shopId)
  if (!usablePricing(pricing)) return backToProduct(ctx, UNAVAILABLE) // never show a NaN / zero price
  return goto(ctx, {
    step: "SHOP_RC_CONFIRM", rcQty: qty, rcUnitPrice: pricing.unitPrice, rcTotal: pricing.totalPaid, rcBulkApplied: pricing.bulkApplied,
  }, shopRcConfirmText(nameOf(ctx), board, qty, pricing.totalPaid, toLocalPhone(session.dialingPhone), pricing.bulkApplied ? pricing.unitPrice : null), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  const board = session.rcBoard
  const qty = session.rcQty
  const shown = session.rcTotal
  const shopId = session.shopId
  // A session missing any of these cannot be priced safely: restart rather than guess.
  if (!isBoard(board) || !shopId || !(typeof qty === "number" && qty >= 1) || !(typeof shown === "number" && Number.isFinite(shown))) {
    return finish(ctx, "Price changed. Please restart your order.")
  }
  if (ctx.input !== "1") {
    const bulkUnit = session.rcBulkApplied && typeof session.rcUnitPrice === "number" ? session.rcUnitPrice : null
    return say(ctx, shopRcConfirmText(nameOf(ctx), board, qty, shown, toLocalPhone(session.dialingPhone), bulkUnit), "SHOP_RC_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Stale-session guard: stock, board switch and the shop's markup may have moved since the
  // confirm screen. Every comparison is written so NaN / undefined fails closed (releases).
  const [enabled, available] = await Promise.all([deps.rc.isBoardEnabled(board), deps.rc.availableCount(board)])
  if (enabled !== true || !(available >= qty)) {
    return finish(ctx, `${board} vouchers are no longer available in that quantity. Please try again.`)
  }
  const pricing = await deps.shop.rcPrice(board, qty, shopId)
  // D11: the Hubtel cart must equal the confirm screen; Uzo silently re-priced here.
  if (!usablePricing(pricing) || !(Math.abs(pricing.totalPaid - shown) <= 0.001)) {
    const to = Number.isFinite(pricing.totalPaid) && pricing.totalPaid > 0 ? ` to GHS ${pricing.totalPaid.toFixed(2)}` : ""
    return finish(ctx, `Price changed${to}. Please restart your order.`)
  }

  return submitOrder(ctx, {
    table: "results_checker_orders",
    price: pricing.totalPaid,
    logTag: "HUBTEL-SHOP-RC",
    // Same columns as lib/shop-commerce/orders.ts createShopRcOrder (the Uzo shop insert); no user_id.
    row: {
      reference_code: secureReference("RC", 2, 3),
      exam_board: board,
      quantity: qty,
      customer_name: "USSD Customer",
      customer_email: null,
      customer_phone: toLocalPhone(session.dialingPhone), // the PINs are SMSed here after payment
      unit_price: pricing.unitPrice,
      fee_amount: 0,
      total_paid: pricing.totalPaid, // the shop price = Hubtel Price; Hubtel adds its own charge on top
      shop_id: shopId,
      merchant_commission: pricing.merchantCommission, // credited to shop_id on voucher delivery
      status: "pending_payment",
      payment_status: "pending_payment",
      dialing_phone: session.dialingPhone,
      channel: "ussd_shop",
    },
  })
}

export const SHOP_RC_STEPS: StepTable = {
  SHOP_RC_SELECT_BOARD: selectBoard,
  SHOP_RC_ENTER_QTY: enterQty,
  SHOP_RC_CONFIRM: confirm,
}
