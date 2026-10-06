// lib/ussd-hubtel/flows/rc-check.ts
// "Check Results" on the Hubtel channel: Datagod checks exam results on the caller's behalf.
// Port of lib/ussd/handlers/results-checker.ts lines 423-916 (USSD channel) minus wallet,
// Paystack and OTP. After payment the request joins the admin queue (/admin/results-check-requests).
import { secureReference } from "@/lib/secure-random"
import {
  isValidDob, isValidExamYear, isValidIndexNumber, isValidVoucherPin, isValidVoucherSerial, type ExamBoard,
} from "@/lib/results-check-validation"
import { rcMenuText } from "../menus"
import { toLocalPhone } from "../protocol"
import { finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { HubtelReply, HubtelSession } from "../types"

const CHECK_BOARDS: ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]
const round2 = (n: number) => Math.round(n * 100) / 100
const ACCOUNT_REQUIRED = "Please create a Datagod account\nwith this number to use\nthis service."

const MENU = { label: "Results Checker" }
const BOARD = { label: "Select exam" }
const TYPE = { label: "Candidate type" }
const MODE = { label: "How to pay" }
const VOUCHER = { label: "Voucher PIN/Serial", fieldType: "text" as const }
const INDEX = { label: "Index number", fieldType: "number" as const }
const YEAR = { label: "Exam year", fieldType: "number" as const }
const DOB = { label: "Date of birth", fieldType: "text" as const }
const WA = { label: "WhatsApp number", fieldType: "phone" as const }
const CONFIRM = { label: "Confirm results check" }

export function rcCheckBoardMenuText(): string {
  return "Check Results\nSelect exam:\n" + CHECK_BOARDS.map((b, i) => `${i + 1}. ${b}`).join("\n") + "\n0. Back"
}
export function rcCheckCandidateTypeText(): string {
  return "Candidate type:\n1. School\n2. Private\n0. Back"
}
export function rcCheckModeText(comboTotal: number, fee: number): string {
  return `Check Results\n1. Buy voucher + check\n   GHS ${comboTotal.toFixed(2)}\n2. I have a voucher\n   GHS ${fee.toFixed(2)}\n0. Back`
}
export function rcCheckVoucherPromptText(board: string): string {
  const eg = board === "BECE" ? "5FBR336742D4/252100270719" : "012345678912/WGR1900112581"
  return `Enter voucher PIN and\nserial as PIN/Serial\ne.g. ${eg}\n0. Back`
}
function invalidVoucherText(board: string): string {
  return board === "BECE"
    ? "Invalid PIN or serial.\nPIN: 10-12 letters/digits\nSerial: digits e.g. 252100270719\nFormat: PIN/Serial\n0. Back"
    : "Invalid PIN or serial.\nPIN: 12 digits\nSerial: e.g. WGR1900112581\nFormat: PIN/Serial\n0. Back"
}
export function rcCheckIndexPromptText(board: string): string {
  return `Enter index number\n(${board === "BECE" ? "10 or 12" : "10"} digits)\ne.g. 0070202043\n0. Back`
}
export function rcCheckYearPromptText(): string {
  return "Enter exam year\n(e.g. 2024):\n0. Back"
}
export function rcCheckDobPromptText(): string {
  return "Enter date of birth\n(DD/MM/YYYY)\ne.g. 15/06/2008\n0. Back"
}
export function rcCheckWaPromptText(): string {
  return "Enter WhatsApp number\nto receive your results\n(e.g. 0244123456):\n0. Back"
}
export function rcCheckConfirmText(a: {
  board: string; candidateType: "school" | "private"; index: string; year: number; dob: string
  mode: "combo" | "own_voucher"; pin?: string; amount: number; payerLocal: string
}): string {
  const who = a.candidateType === "school" ? "School" : "Private"
  const detail = a.mode === "combo" ? "Voucher + check" : `PIN ${a.pin ?? ""}`
  return (
    `Check Results\n${a.board} (${who})\nIndex ${a.index} Year ${a.year}\nDOB ${a.dob}\n${detail}\n` +
    `GHS ${a.amount.toFixed(2)} from ${a.payerLocal}\n1. Pay now\n2. Cancel`
  )
}

const sessionAmount = (s: HubtelSession): number => (s.rcCheckMode === "combo" ? s.rcCheckComboTotal! : s.rcCheckFee!)

function confirmText(s: HubtelSession): string {
  return rcCheckConfirmText({
    board: s.rcCheckBoard!, candidateType: s.rcCheckCandidateType ?? "school", index: s.rcCheckIndex!, year: s.rcCheckYear!,
    dob: s.rcCheckDob!, mode: s.rcCheckMode ?? "own_voucher", pin: s.rcCheckVoucherPin, amount: sessionAmount(s),
    payerLocal: toLocalPhone(s.dialingPhone),
  })
}

/**
 * Combo = one voucher (single, no bulk) + the check fee; only for a board that is enabled and in
 * stock. Fails closed: a non-true flag, a NaN stock count or a non-finite / non-positive total all
 * mean "not offered" (undefined).
 */
async function comboTotalFor(ctx: FlowCtx, board: ExamBoard, fee: number): Promise<number | undefined> {
  const [enabled, available] = await Promise.all([ctx.deps.rc.isBoardEnabled(board), ctx.deps.rc.availableCount(board)])
  if (enabled !== true || !(available >= 1)) return undefined
  const { unitPrice } = await ctx.deps.rc.price(board, 1, false)
  const total = round2(unitPrice + fee)
  return Number.isFinite(total) && total > 0 ? total : undefined
}

export async function startRcCheck(ctx: FlowCtx): Promise<HubtelReply> {
  const settings = await ctx.deps.rc.checkSettings()
  if (settings.enabled !== true) return say(ctx, "Service not available.\n" + rcMenuText(), "RC_MENU", MENU)
  const dialer = await ctx.deps.resolveDialer(ctx.session.dialingPhone)
  if (!dialer.userId) return finish(ctx, ACCOUNT_REQUIRED)
  return goto(ctx, { step: "RC_CHECK_BOARD", userId: dialer.userId }, rcCheckBoardMenuText(), BOARD)
}

const toBoard = (ctx: FlowCtx) => goto(ctx, { step: "RC_CHECK_BOARD" }, rcCheckBoardMenuText(), BOARD)
const toType = (ctx: FlowCtx) => goto(ctx, { step: "RC_CHECK_CANDIDATE_TYPE" }, rcCheckCandidateTypeText(), TYPE)
const toMode = (ctx: FlowCtx) =>
  goto(ctx, { step: "RC_CHECK_MODE" }, rcCheckModeText(ctx.session.rcCheckComboTotal!, ctx.session.rcCheckFee!), MODE)
const toVoucher = (ctx: FlowCtx, prefix = "") =>
  goto(ctx, { step: "RC_CHECK_VOUCHER", rcCheckMode: "own_voucher" }, prefix + rcCheckVoucherPromptText(ctx.session.rcCheckBoard!), VOUCHER)

async function checkBoard(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "RC_MENU" }, rcMenuText(), MENU)
  const board = /^\d$/.test(ctx.input) ? CHECK_BOARDS[Number(ctx.input) - 1] : undefined
  if (!board) return say(ctx, rcCheckBoardMenuText(), "RC_CHECK_BOARD", BOARD)
  const settings = await ctx.deps.rc.checkSettings()
  const comboTotal = await comboTotalFor(ctx, board, settings.fee)
  return goto(ctx, {
    step: "RC_CHECK_CANDIDATE_TYPE", rcCheckBoard: board, rcCheckFee: settings.fee, rcCheckComboTotal: comboTotal,
    rcCheckMode: undefined, rcCheckVoucherPin: undefined, rcCheckVoucherSerial: undefined,
  }, rcCheckCandidateTypeText(), TYPE)
}

async function candidateType(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return toBoard(ctx)
  if (ctx.input !== "1" && ctx.input !== "2") return say(ctx, rcCheckCandidateTypeText(), "RC_CHECK_CANDIDATE_TYPE", TYPE)
  const t = ctx.input === "1" ? "school" : "private"
  if (s.rcCheckComboTotal !== undefined) {
    return goto(ctx, { step: "RC_CHECK_MODE", rcCheckCandidateType: t }, rcCheckModeText(s.rcCheckComboTotal, s.rcCheckFee!), MODE)
  }
  return goto(ctx, { step: "RC_CHECK_VOUCHER", rcCheckCandidateType: t, rcCheckMode: "own_voucher" },
    "No vouchers in stock.\nUse your own voucher.\n" + rcCheckVoucherPromptText(s.rcCheckBoard!), VOUCHER)
}

async function mode(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return toType(ctx)
  if (ctx.input === "1") {
    return goto(ctx, { step: "RC_CHECK_INDEX", rcCheckMode: "combo", rcCheckVoucherPin: undefined, rcCheckVoucherSerial: undefined },
      rcCheckIndexPromptText(s.rcCheckBoard!), INDEX)
  }
  if (ctx.input === "2") return toVoucher(ctx)
  return say(ctx, rcCheckModeText(s.rcCheckComboTotal!, s.rcCheckFee!), "RC_CHECK_MODE", MODE)
}

async function voucher(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  const board = s.rcCheckBoard as ExamBoard
  if (ctx.input === "0") return s.rcCheckComboTotal !== undefined ? toMode(ctx) : toType(ctx)
  // Accept "PIN/Serial", "PIN Serial" or "PIN,Serial" (Uzo format), case-insensitive.
  const [pin = "", serial = ""] = ctx.input.toUpperCase().split(/[\/,\s]+/)
  if (!isValidVoucherPin(board, pin) || !isValidVoucherSerial(board, serial)) {
    return say(ctx, invalidVoucherText(board), "RC_CHECK_VOUCHER", VOUCHER)
  }
  return goto(ctx, { step: "RC_CHECK_INDEX", rcCheckVoucherPin: pin, rcCheckVoucherSerial: serial }, rcCheckIndexPromptText(board), INDEX)
}

async function index(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  const board = s.rcCheckBoard as ExamBoard
  if (ctx.input === "0") return s.rcCheckMode === "own_voucher" ? toVoucher(ctx) : toMode(ctx)
  const idx = ctx.input.replace(/\s/g, "")
  if (!isValidIndexNumber(board, idx)) return say(ctx, "Invalid index number.\n" + rcCheckIndexPromptText(board), "RC_CHECK_INDEX", INDEX)
  return goto(ctx, { step: "RC_CHECK_YEAR", rcCheckIndex: idx }, rcCheckYearPromptText(), YEAR)
}

async function year(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "RC_CHECK_INDEX" }, rcCheckIndexPromptText(ctx.session.rcCheckBoard!), INDEX)
  const y = /^\d{4}$/.test(ctx.input) ? Number(ctx.input) : NaN
  if (!isValidExamYear(y)) {
    return say(ctx, `Invalid year.\nEnter a year from 1980\nto ${new Date().getFullYear()}.\n0. Back`, "RC_CHECK_YEAR", YEAR)
  }
  return goto(ctx, { step: "RC_CHECK_DOB", rcCheckYear: y }, rcCheckDobPromptText(), DOB)
}

async function dob(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "RC_CHECK_YEAR" }, rcCheckYearPromptText(), YEAR)
  const normalised = ctx.input.replace(/-/g, "/")
  if (!isValidDob(normalised)) return say(ctx, "Invalid date.\nUse DD/MM/YYYY\ne.g. 15/06/2008\n0. Back", "RC_CHECK_DOB", DOB)
  return goto(ctx, { step: "RC_CHECK_WA_NUMBER", rcCheckDob: normalised }, rcCheckWaPromptText(), WA)
}

async function waNumber(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "RC_CHECK_DOB" }, rcCheckDobPromptText(), DOB)
  const local = toLocalPhone(ctx.input.replace(/\s+/g, ""))
  // Mandatory: results (incl. image/PDF) are delivered to this WhatsApp number.
  if (!/^0[2345]\d{8}$/.test(local)) return say(ctx, "Invalid number.\n" + rcCheckWaPromptText(), "RC_CHECK_WA_NUMBER", WA)
  const next: HubtelSession = { ...ctx.session, rcCheckWaNumber: local }
  return goto(ctx, { step: "RC_CHECK_CONFIRM", rcCheckWaNumber: local }, confirmText(next), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session: s } = ctx
  const board = s.rcCheckBoard as ExamBoard
  const mode = s.rcCheckMode ?? "own_voucher"
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  if (ctx.input !== "1") return say(ctx, confirmText(s), "RC_CHECK_CONFIRM", CONFIRM)

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Re-verify everything that sets the price or gates the service. Every comparison is written so
  // NaN / undefined fails closed (releases) rather than selling.
  const settings = await deps.rc.checkSettings()
  if (settings.enabled !== true) return finish(ctx, "Results check is not available right now.")
  const dialer = await deps.resolveDialer(s.dialingPhone)
  if (!dialer.userId) return finish(ctx, ACCOUNT_REQUIRED)
  let amount = settings.fee
  if (mode === "combo") {
    const combo = await comboTotalFor(ctx, board, settings.fee)
    if (combo === undefined) return finish(ctx, `${board} vouchers are sold out.\nPlease restart and use\nyour own voucher.`)
    amount = combo
  }
  if (!(Math.abs(amount - sessionAmount(s)) <= 0.001)) {
    const shown = Number.isFinite(amount) ? ` to GHS ${amount.toFixed(2)}` : ""
    return finish(ctx, `Price changed${shown}. Please restart your order.`)
  }

  return submitOrder(ctx, {
    table: "results_check_requests",
    price: amount,
    logTag: "HUBTEL-RC-CHECK",
    row: {
      phone_number: toLocalPhone(s.dialingPhone), // payment confirmation + SMS results go here
      exam_board: board,
      candidate_type: s.rcCheckCandidateType ?? "school",
      index_number: s.rcCheckIndex,
      dob: s.rcCheckDob ?? null,
      exam_year: s.rcCheckYear,
      fee: amount, // our price; Hubtel adds its own charge on top, at Hubtel
      payment_status: "pending_payment",
      status: "pending",
      channel: "ussd",
      user_id: dialer.userId,
      payment_reference: secureReference("RCK", 2, 3),
      mode,
      voucher_pin: mode === "own_voucher" ? (s.rcCheckVoucherPin ?? null) : null,
      voucher_serial: mode === "own_voucher" ? (s.rcCheckVoucherSerial ?? null) : null,
      whatsapp_number: s.rcCheckWaNumber ?? null,
    },
  })
}

export const RC_CHECK_STEPS: StepTable = {
  RC_CHECK_BOARD: checkBoard,
  RC_CHECK_CANDIDATE_TYPE: candidateType,
  RC_CHECK_MODE: mode,
  RC_CHECK_VOUCHER: voucher,
  RC_CHECK_INDEX: index,
  RC_CHECK_YEAR: year,
  RC_CHECK_DOB: dob,
  RC_CHECK_WA_NUMBER: waNumber,
  RC_CHECK_CONFIRM: confirm,
}
