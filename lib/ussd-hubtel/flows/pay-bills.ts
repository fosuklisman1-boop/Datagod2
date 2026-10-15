// lib/ussd-hubtel/flows/pay-bills.ts
// "Pay Bills" (Commission Cashback bots): Utility Bills sold over Hubtel USSD. Accounts are looked up with the
// bot engine (botVerifyBill: masked names, tokens bound to this bot + shop), priced with quoteBots (rail hubtel;
// shop split only for an accepted shop in shop mode) and ordered with botCreateBillOrder (unpaid, deduped on the
// verify token). submitOrder then writes the hubtel_transactions row and the cart at the order's payAmount.
// Ghana Water is never offered (WhatsApp only; the engine refuses it on USSD as well).
import { isValidGhanaMobile } from "@/lib/phone-format"
import { isValidAmountInput, normaliseInputs, type BillerKey } from "@/lib/bills/billers"
import type { VerifyResult } from "@/lib/bills/service"
import type { BotContext } from "@/lib/bot-commission/context"
import type { PayBillsVerifyInput } from "../services"
import { toLocalPhone, USSD_SCREEN_LIMIT } from "../protocol"
import {
  backToMain, failOrphanEngineOrder, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable,
} from "../flow-kit"
import { clip, fitListScreen, pageSlice } from "../screen-fit"
import { backToProduct } from "./shop"
import type { HubtelReply, HubtelSession, PbAccountStage, PbMeter } from "../types"

export const PB_PAGE_SIZE = 5

/** Billers offered on USSD, in menu order, with their short names. Ghana Water is deliberately absent. */
export const PB_BILLER_LABEL: Partial<Record<BillerKey, string>> = {
  ecg: "ECG", dstv: "DStv", gotv: "GOtv", startimes: "StarTimes", telecel_broadband: "Telecel Broadband",
}
const ussdBiller = (k: string): k is BillerKey => Object.prototype.hasOwnProperty.call(PB_BILLER_LABEL, k)
const labelOf = (k: string | undefined) => (k && ussdBiller(k) ? PB_BILLER_LABEL[k]! : "Bill")

export const PB_TEXT = {
  unavailable: "Service unavailable. Please try again later.",
  priceChanged: "Price changed. Please try again.",
  tooMany: "Too many attempts. Please try later.",
  notAvailable: "Not available right now.",
  verifyFailed: "Could not verify this account. Check and try again.",
  invalidDetails: "Invalid details. Check and try again.",
  invalidPhone: "Invalid number. Enter a valid Ghana phone number.",
  cancelled: "Order cancelled.",
} as const

const BILLER = { label: "Pay Bills" }
const ECG_MODE = { label: "ECG account" }
const METERS = { label: "Select meter" }
const METER_TYPE = { label: "Meter type" }
const CONSENT = { label: "Link meter" }
const AMOUNT = { label: "Amount", fieldType: "decimal" as const }
const CONFIRM = { label: "Confirm payment" }

const money = (n: number) => n.toFixed(2)

const billerScreen = (billers: { key: string }[], prefix = "") =>
  fitListScreen(`${prefix}Pay Bills`, billers.map(b => ({ label: labelOf(b.key) })), ["0 Back"])

const ecgModeScreen = (prefix = "") => `${prefix}ECG\n1 This number\n2 Other number\n3 Meter number\n0 Back`

const ACCOUNT_PROMPT: Record<PbAccountStage, (s: HubtelSession) => string> = {
  phone: () => "Enter the phone number linked to the meter:",
  meter: () => "Enter meter number:",
  account: s => (s.pbBiller === "startimes" ? "Enter account number:" : "Enter smartcard number:"),
  landline: () => "Enter the landline number (e.g. 0302450262):",
  broadband: () => "Enter the broadband account number:",
}
const accountScreen = (s: HubtelSession, stage: PbAccountStage, prefix = "") => `${prefix}${ACCOUNT_PROMPT[stage](s)}\n0 Back`
const accountOpts = (stage: PbAccountStage) => ({ label: "Account", ...(stage === "phone" ? { fieldType: "phone" as const } : {}) })

function metersScreen(meters: PbMeter[], hasNext: boolean): string {
  return fitListScreen(
    "Select meter:",
    meters.map(m => ({ label: m.n ? `${m.m} ${m.n}` : m.m, suffix: m.o !== null && m.o > 0 ? `Due GHS ${money(m.o)}` : undefined })),
    [...(hasNext ? ["0 Next"] : []), "00 Back"],
  )
}

const meterTypeScreen = (meter: string, prefix = "") => `${prefix}Meter ${meter}\nMeter type:\n1 Prepaid\n2 Postpaid\n0 Back`

/** Consent before an unlinked meter is linked to the phone (the top-up links it at Hubtel). */
export const consentScreen = (meter: string, phone: string) =>
  `Meter ${meter} is not linked to ${phone}.\n1 Yes, link meter ${meter} to ${phone}\n2 Cancel\n0 Back`

/** Shortest a customer name is shown before its line is dropped. */
const MIN_NAME = 4

/**
 * Amount prompt, at most 182 chars with the prompt and "0 Back" always whole: when too long the name is shortened
 * first (dropped below 4 chars), then the account. Never left to fitMessage, which would cut the footer.
 */
export function amountScreen(s: HubtelSession, prefix = ""): string {
  let name = s.pbName ? clip(s.pbName, 40) : ""
  let account = s.pbAccount ?? ""
  const due = s.pbDue !== null && s.pbDue !== undefined && s.pbDue > 0 ? [`Due: GHS ${money(s.pbDue)}`] : []
  const render = () => [
    `${prefix}${labelOf(s.pbBiller)} ${account}`.trimEnd(),
    ...(name ? [`Name: ${name}`] : []),
    ...due,
    `Enter amount (GHS ${money(s.pbMin ?? 0)} - ${money(s.pbMax ?? 0)}):`,
    "0 Back",
  ].join("\n")
  let text = render()
  let over = text.length - USSD_SCREEN_LIMIT
  if (over > 0 && name) {
    name = name.length - over >= MIN_NAME ? clip(name, name.length - over) : ""
    text = render()
    over = text.length - USSD_SCREEN_LIMIT
  }
  if (over > 0 && account) {
    account = clip(account, account.length - over)
    text = render()
  }
  return text
}

/** Confirm screen (≤ 182 chars; the account part is shortened if needed). "(was …)" only when the price is below face. */
export function payBillConfirmText(s: Pick<HubtelSession, "pbBiller" | "pbAccount" | "pbMeterType" | "pbFace" | "pbPay">): string {
  const pay = s.pbPay ?? 0
  const face = s.pbFace ?? 0
  const was = pay < face ? ` (was GHS ${money(face)})` : ""
  const type = s.pbBiller === "ecg" && s.pbMeterType ? (s.pbMeterType === "prepaid" ? " Prepaid" : " Postpaid") : ""
  const head = `Pay GHS ${money(pay)}${was}\nYou receive GHS ${money(face)} `
  const tail = "\n1 Confirm 2 Cancel"
  return head + clip(`${labelOf(s.pbBiller)}${type} on ${s.pbAccount ?? ""}`, USSD_SCREEN_LIMIT - head.length - tail.length) + tail
}

/** The engine context for this session: shop split only for an accepted shop in shop mode; null = fail closed. */
function botContext(s: HubtelSession): BotContext | null {
  if (s.mode === "shop") {
    if (!s.shopId) return null
    return { botSurface: "hubtel_ussd", shopId: s.shopId, rail: "hubtel", buyerPhone: s.dialingPhone }
  }
  return { botSurface: "hubtel_ussd", shopId: null, rail: "hubtel", buyerPhone: s.dialingPhone }
}

/** Back out of the flow: main menu (main mode) or the shop's product menu (shop mode). */
const leave = (ctx: FlowCtx) => (ctx.session.mode === "shop" ? backToProduct(ctx) : backToMain(ctx))

/** Every pb* field cleared (a fresh biller choice never inherits an earlier account or price). */
const CLEARED: Partial<HubtelSession> = {
  pbBiller: undefined, pbMin: undefined, pbMax: undefined, pbEcgMode: undefined, pbStage: undefined, pbPhone: undefined,
  pbLandline: undefined, pbAccount: undefined, pbMeterType: undefined, pbMeters: undefined, pbPage: undefined,
  pbToken: undefined, pbName: undefined, pbDue: undefined, pbFace: undefined, pbPay: undefined,
}

export async function startPayBills(ctx: FlowCtx): Promise<HubtelReply> {
  if (!botContext(ctx.session)) return finish(ctx, PB_TEXT.unavailable)
  let billers
  try {
    billers = (await ctx.deps.payBills.billers()).filter(b => ussdBiller(b.key))
  } catch (e) {
    console.error("[HUBTEL-PB] billers failed:", e instanceof Error ? e.message : "error")
    return finish(ctx, PB_TEXT.unavailable)
  }
  if (billers.length === 0) return finish(ctx, PB_TEXT.notAvailable)
  const list = billers.map(b => ({ key: b.key, min: b.min, max: b.max }))
  return goto(ctx, { ...CLEARED, step: "PB_BILLER", pbBillers: list }, billerScreen(list), BILLER)
}

const toBillers = (ctx: FlowCtx, prefix = "") =>
  goto(ctx, { ...CLEARED, step: "PB_BILLER" }, billerScreen(ctx.session.pbBillers ?? [], prefix), BILLER)
const toEcgMode = (ctx: FlowCtx, prefix = "") =>
  goto(ctx, { step: "PB_ECG_MODE", pbMeters: undefined, pbPage: undefined, pbToken: undefined }, ecgModeScreen(prefix), ECG_MODE)
const toStage = (ctx: FlowCtx, stage: PbAccountStage, patch: Partial<HubtelSession> = {}, prefix = "") => {
  const next = { ...ctx.session, ...patch }
  return goto(ctx, { ...patch, step: "PB_ACCOUNT", pbStage: stage }, accountScreen(next, stage, prefix), accountOpts(stage))
}
const toAmount = (ctx: FlowCtx, patch: Partial<HubtelSession>, prefix = "") =>
  goto(ctx, { ...patch, step: "PB_AMOUNT" }, amountScreen({ ...ctx.session, ...patch }, prefix), AMOUNT)

async function selectBiller(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return leave(ctx)
  const billers = ctx.session.pbBillers ?? []
  const b = /^\d$/.test(ctx.input) ? billers[Number(ctx.input) - 1] : undefined
  if (!b || !ussdBiller(b.key)) return say(ctx, billerScreen(billers), "PB_BILLER", BILLER)
  const base = { ...CLEARED, pbBiller: b.key, pbMin: b.min, pbMax: b.max }
  if (b.key === "ecg") return goto(ctx, { ...base, step: "PB_ECG_MODE" }, ecgModeScreen(), ECG_MODE)
  return toStage(ctx, b.key === "telecel_broadband" ? "landline" : "account", base)
}

async function selectEcgMode(ctx: FlowCtx): Promise<HubtelReply> {
  const own = toLocalPhone(ctx.session.dialingPhone)
  switch (ctx.input) {
    case "0": return toBillers(ctx)
    case "1": return lookupMeters(ctx, own, "self")
    case "2": return toStage(ctx, "phone", { pbEcgMode: "other" })
    case "3": return toStage(ctx, "meter", { pbEcgMode: "meter", pbPhone: own, pbMeters: undefined })
    default: return say(ctx, ecgModeScreen(), "PB_ECG_MODE", ECG_MODE)
  }
}

/** botVerifyBill; a throw is reported as a 503 (never shown). */
async function verify(ctx: FlowCtx, bc: BotContext, input: PayBillsVerifyInput): Promise<VerifyResult> {
  try {
    return await ctx.deps.payBills.verify(bc, input)
  } catch (e) {
    console.error("[HUBTEL-PB] verify threw:", e instanceof Error ? e.message : "error", "session:", ctx.req.SessionId)
    return { ok: false, status: 503, error: "error" }
  }
}

/** Fixed text for a failed lookup (never the provider's message): 422/400 => retry screen, 429/403/other => end. */
function verifyFailed(ctx: FlowCtx, r: { status: number }, retry: (prefix: string) => Promise<HubtelReply>): Promise<HubtelReply> {
  if (r.status === 429) return finish(ctx, PB_TEXT.tooMany)
  if (r.status === 403) return finish(ctx, PB_TEXT.notAvailable)
  if (r.status === 422) return retry(PB_TEXT.verifyFailed + "\n")
  if (r.status === 400) return retry(PB_TEXT.invalidDetails + "\n")
  return finish(ctx, PB_TEXT.unavailable)
}

const toMeters = (r: Extract<VerifyResult, { ok: true }>): PbMeter[] =>
  (r.meters ?? []).map(m => ({ m: m.meter, n: m.name, o: m.outstanding, t: m.token }))

/** ECG meters linked to `phone`: a list to pick from, or (none) the meter-number entry. */
async function lookupMeters(ctx: FlowCtx, phone: string, mode: "self" | "other"): Promise<HubtelReply> {
  const bc = botContext(ctx.session)
  if (!bc) return finish(ctx, PB_TEXT.unavailable)
  const r = await verify(ctx, bc, { biller: "ecg", phone })
  if (!r.ok) {
    return verifyFailed(ctx, r, p => (mode === "self" ? toEcgMode(ctx, p) : toStage(ctx, "phone", { pbEcgMode: "other" }, p)))
  }
  const meters = toMeters(r)
  const patch = { pbEcgMode: mode, pbPhone: phone, pbMeters: meters }
  if (meters.length === 0) return toStage(ctx, "meter", patch, `No meters linked to ${phone}.\n`)
  return showMeters(ctx, 0, patch)
}

function showMeters(ctx: FlowCtx, page: number, patch: Partial<HubtelSession> = {}): Promise<HubtelReply> {
  const meters = patch.pbMeters ?? ctx.session.pbMeters ?? []
  const slice = pageSlice(meters, page, PB_PAGE_SIZE)
  return goto(ctx, { ...patch, step: "PB_METERS", pbPage: slice.page }, metersScreen(slice.items, slice.hasNext), METERS)
}

async function selectMeter(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  const page = s.pbPage ?? 0
  if (ctx.input === "00") return page > 0 ? showMeters(ctx, page - 1) : toEcgMode(ctx)
  if (ctx.input === "0") return showMeters(ctx, page + 1)
  const slice = pageSlice(s.pbMeters ?? [], page, PB_PAGE_SIZE)
  const m = /^\d$/.test(ctx.input) ? slice.items[Number(ctx.input) - 1] : undefined
  if (!m) return showMeters(ctx, page)
  return toAmount(ctx, { pbAccount: m.m, pbToken: m.t, pbName: m.n, pbDue: m.o, pbMeterType: undefined })
}

async function enterAccount(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  const stage = s.pbStage ?? "account"
  const retry = async (prefix: string) => say(ctx, accountScreen(s, stage, prefix), "PB_ACCOUNT", accountOpts(stage))
  if (ctx.input === "0") {
    if (stage === "phone" || stage === "meter") return toEcgMode(ctx)
    if (stage === "broadband") return toStage(ctx, "landline")
    return toBillers(ctx)
  }
  const value = ctx.input.replace(/\s+/g, "")
  const biller = s.pbBiller
  if (!biller || !ussdBiller(biller)) return finish(ctx, PB_TEXT.unavailable)

  if (stage === "phone") {
    const local = toLocalPhone(value)
    if (!/^0\d{9}$/.test(local) || !isValidGhanaMobile(local)) return retry(PB_TEXT.invalidPhone + "\n")
    return lookupMeters(ctx, local, "other")
  }
  if (stage === "meter") {
    const n = normaliseInputs("ecg", { phone: s.pbPhone, account: value })
    if (!n.ok || !n.value.account) return retry("Enter a valid meter number.\n")
    return goto(ctx, { step: "PB_METER_TYPE", pbAccount: n.value.account, pbMeterType: undefined }, meterTypeScreen(n.value.account), METER_TYPE)
  }
  if (stage === "landline") {
    if (!/^0\d{9}$/.test(value)) return retry("Enter the 10-digit landline.\n")
    return toStage(ctx, "broadband", { pbLandline: value })
  }
  const inputs = stage === "broadband" ? { account: s.pbLandline, broadbandAccount: value } : { account: value }
  const n = normaliseInputs(biller, inputs)
  if (!n.ok) return retry(PB_TEXT.invalidDetails + "\n")
  const bc = botContext(s)
  if (!bc) return finish(ctx, PB_TEXT.unavailable)
  const r = await verify(ctx, bc, { biller, ...inputs })
  if (!r.ok) return verifyFailed(ctx, r, retry)
  if (!r.token) return finish(ctx, PB_TEXT.unavailable)
  return toAmount(ctx, { pbAccount: n.value.account, pbToken: r.token, pbName: r.customerName, pbDue: r.amountDue })
}

async function selectMeterType(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return toStage(ctx, "meter")
  const type = ctx.input === "1" ? "prepaid" : ctx.input === "2" ? "postpaid" : undefined
  if (!type || !s.pbAccount || !s.pbPhone) return say(ctx, meterTypeScreen(s.pbAccount ?? ""), "PB_METER_TYPE", METER_TYPE)
  const bc = botContext(s)
  if (!bc) return finish(ctx, PB_TEXT.unavailable)
  // A meter typed directly may already be linked to the phone: then its own token is used (no consent needed).
  let meters = s.pbMeters
  if (meters === undefined) {
    const r = await verify(ctx, bc, { biller: "ecg", phone: s.pbPhone })
    if (!r.ok) return verifyFailed(ctx, r, async p => say(ctx, meterTypeScreen(s.pbAccount!, p), "PB_METER_TYPE", METER_TYPE))
    meters = toMeters(r)
  }
  const hit = meters.find(m => m.m.toLowerCase() === s.pbAccount!.toLowerCase())
  if (hit) return toAmount(ctx, { pbMeterType: type, pbMeters: meters, pbAccount: hit.m, pbToken: hit.t, pbName: hit.n, pbDue: hit.o })
  return goto(ctx, { step: "PB_CONSENT", pbMeterType: type, pbMeters: meters }, consentScreen(s.pbAccount, s.pbPhone), CONSENT)
}

async function giveConsent(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return goto(ctx, { step: "PB_METER_TYPE" }, meterTypeScreen(s.pbAccount ?? ""), METER_TYPE)
  if (ctx.input === "2") return finish(ctx, PB_TEXT.cancelled)
  if (ctx.input !== "1" || !s.pbAccount || !s.pbPhone) return say(ctx, consentScreen(s.pbAccount ?? "", s.pbPhone ?? ""), "PB_CONSENT", CONSENT)
  const bc = botContext(s)
  if (!bc) return finish(ctx, PB_TEXT.unavailable)
  const r = await verify(ctx, bc, { biller: "ecg", phone: s.pbPhone, account: s.pbAccount, addMeter: true, consent: true })
  if (!r.ok) return verifyFailed(ctx, r, p => toStage(ctx, "meter", {}, p))
  if (!r.token) return finish(ctx, PB_TEXT.unavailable)
  return toAmount(ctx, { pbToken: r.token, pbName: r.customerName, pbDue: r.amountDue })
}

async function enterAmount(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return toBillers(ctx)
  const min = s.pbMin ?? 0
  const max = s.pbMax ?? 0
  const amount = isValidAmountInput(ctx.input) ? Number(ctx.input) : NaN
  if (!(amount > 0) || amount < min || amount > max) {
    return say(ctx, amountScreen(s, `Enter an amount from GHS ${money(min)} to GHS ${money(max)}.\n`), "PB_AMOUNT", AMOUNT)
  }
  const bc = botContext(s)
  const biller = s.pbBiller
  if (!bc || !biller || !ussdBiller(biller) || !s.pbToken) return finish(ctx, PB_TEXT.unavailable)
  const face = Math.round(amount * 100) / 100
  let pay: number
  try {
    pay = (await ctx.deps.payBills.quote(bc, biller, face)).payAmount
  } catch (e) {
    console.error("[HUBTEL-PB] quote failed:", e instanceof Error ? e.message : "error", "session:", ctx.req.SessionId)
    return finish(ctx, PB_TEXT.unavailable)
  }
  if (!(pay > 0)) return finish(ctx, PB_TEXT.unavailable)
  const patch = { pbFace: face, pbPay: pay }
  return goto(ctx, { ...patch, step: "PB_CONFIRM" }, payBillConfirmText({ ...s, ...patch }), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, req, session } = ctx
  if (input === "2") return finish(ctx, PB_TEXT.cancelled)
  if (input !== "1") return say(ctx, payBillConfirmText(session), "PB_CONFIRM", CONFIRM)

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  const bc = botContext(session)
  if (!bc || !session.pbToken || !(session.pbFace! > 0) || !(session.pbPay! > 0)) return finish(ctx, PB_TEXT.unavailable)

  // The engine dedupes on the verify token: a retried CONFIRM with this session's token returns the same order.
  const token = session.pbToken
  let r
  try {
    r = await deps.payBills.createOrder(bc, { token, amount: session.pbFace, expectedPay: session.pbPay })
  } catch (e) {
    console.error("[HUBTEL-PB] createOrder threw:", e instanceof Error ? e.message : "error", "session:", req.SessionId)
    // It may have committed before throwing: an order from this token would sit pending + unpaid with no checkout.
    const orphan = await deps.payBills.findOrderId(bc, token).catch((err: unknown) => {
      console.error("[HUBTEL-PB] orphan lookup failed:", err instanceof Error ? err.message : "error", "session:", req.SessionId)
      return null
    })
    if (orphan) await failOrphanEngineOrder(deps, "hubtel_bill_orders", orphan, "HUBTEL-PB", req.SessionId)
    return finish(ctx, PB_TEXT.unavailable)
  }
  if (!r.ok) {
    if (r.status === 409) return finish(ctx, PB_TEXT.priceChanged)
    if (r.status === 429) return finish(ctx, PB_TEXT.tooMany)
    if (r.status === 403) return finish(ctx, PB_TEXT.notAvailable)
    return finish(ctx, PB_TEXT.unavailable)
  }
  // The engine may hand back an existing order for this token: only a still-open one (pending + unpaid) is carted.
  const { data: row, error } = await deps.supabase
    .from("hubtel_bill_orders").select("status, payment_status").eq("id", r.order.id).maybeSingle()
  const open = row as { status?: string; payment_status?: string } | null
  if (error || open?.status !== "pending" || open?.payment_status !== "unpaid") {
    console.error("[HUBTEL-PB] Engine order is not open; refusing to cart:", r.order.id, open?.status ?? null, open?.payment_status ?? null, "session:", req.SessionId)
    // Read error / no row: its state is unknown, so fail it (guarded: only a still pending + unpaid bots row is
    // touched). A row read as not open is already paid or closed: the guarded patch could not touch it anyway.
    if (error || !open) await failOrphanEngineOrder(deps, "hubtel_bill_orders", r.order.id, "HUBTEL-PB", req.SessionId)
    return finish(ctx, PB_TEXT.unavailable)
  }
  return submitOrder(ctx, { table: "hubtel_bill_orders", orderId: r.order.id, price: r.order.payAmount, logTag: "HUBTEL-PB" })
}

export const PAY_BILLS_STEPS: StepTable = {
  PB_BILLER: selectBiller,
  PB_ECG_MODE: selectEcgMode,
  PB_ACCOUNT: enterAccount,
  PB_METER_TYPE: selectMeterType,
  PB_METERS: selectMeter,
  PB_CONSENT: giveConsent,
  PB_AMOUNT: enterAmount,
  PB_CONFIRM: confirm,
}
