// "Pay Bills" (Commission Cashback bots) on the Uzo menus: Utility Bills sold on the main USSD (surface "ussd", no
// shop) and the shop USSD (surface "ussd_shop", the session's resolved shop). Accounts are looked up with the bot
// engine (botVerifyBill: masked names, tokens bound to this bot + shop), priced with quoteBots on rail paystack,
// ordered with botCreateBillOrder (unpaid, deduped on the verify token) and paid by a MoMo prompt to the dialing
// number only. Pattern: lib/ussd-hubtel/flows/pay-bills.ts (same steps and rules, Uzo text conventions).
// Ghana Water is never offered (WhatsApp only; the engine refuses it on USSD as well).
import { isValidAmountInput, normaliseInputs, BILLERS, BILLER_KEYS, type BillerKey, type BillInputs } from "@/lib/bills/billers"
import { billTokenHash, type VerifyResult } from "@/lib/bills/service"
import { quoteBots } from "@/lib/cashback/quote"
import { resolveBotContext, type BotContext } from "@/lib/bot-commission/context"
import { botChargeMomo, getBotMomoRuntime } from "@/lib/bot-commission/momo"
import { failBotCharge } from "@/lib/bot-commission/momo-fail"
import { botCreateBillOrder, BOT_BILL_TOKEN_EXPIRED, type BotBillOrderInput, type BotOrderResult } from "@/lib/bot-commission/orders"
import { getBotBillsRuntime } from "@/lib/bot-commission/runtime"
import { botVerifyBill } from "@/lib/bot-commission/verify"
import { isValidGhanaMobile, normalizeGhanaPhone } from "@/lib/phone-format"
import type { UzoPbAccountStage, UzoPbMeter, UzoPbSessionFields, UzoResponse } from "../types"
import {
  ascii, liveUzoBotIo, samePrice, uzoBotClosedSession, uzoBotContext, uzoChargeOrder, uzoShopHeader, withoutBotFields,
  UZO_BOT_RESTART, UZO_BOT_UNAVAILABLE, type UzoBotCtx, type UzoBotIo, type UzoBotPayDeps, type UzoBotSession,
} from "./kit"
import { botErrorText, fitsUzo, uzoConfirmText, uzoPagedList, uzoSafeLabel, UZO_SCREEN_LIMIT } from "./screen"

export type { UzoBotCtx, UzoBotSession } from "./kit"

export const PB_PAGE_SIZE = 5
const TAG = "USSD-PB"

/** Billers offered on the Uzo menus, in menu order, with their short names. Ghana Water is deliberately absent. */
export const PB_BILLER_LABEL: Partial<Record<BillerKey, string>> = {
  ecg: "ECG", dstv: "DStv", gotv: "GOtv", startimes: "StarTimes", telecel_broadband: "Telecel Broadband",
}
const ussdBiller = (k: unknown): k is BillerKey =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(PB_BILLER_LABEL, k)
const labelOf = (k: string | undefined) => (ussdBiller(k) ? PB_BILLER_LABEL[k]! : "Bill")

export const PB_TEXT = {
  notAvailable: botErrorText(403),
  verifyFailed: "Could not verify this account. Check and try again.",
  invalidDetails: "Invalid details. Check and try again.",
  invalidPhone: "Invalid number.",
  invalidMeter: "Enter a valid meter number.",
  invalidLandline: "Enter the 10-digit landline.",
  cancelled: "Order cancelled.",
} as const

export interface PbBiller { key: BillerKey; min: number; max: number }
export type PbVerifyInput = { biller: string } & BillInputs & { addMeter?: boolean; consent?: boolean }

/** Everything the flow touches outside itself (live wiring below; tests inject fakes). */
export interface PayBillsDeps extends UzoBotPayDeps {
  io: UzoBotIo
  /** Billers switched on in the Utility Bills config (master + per biller), in BILLER_KEYS order. Throws on read error. */
  billers(): Promise<PbBiller[]>
  /** botVerifyBill: masked names, bot-bound tokens, Ghana Water refused on USSD. */
  verify(bc: BotContext, input: PbVerifyInput): Promise<VerifyResult>
  /** The price the engine will charge for `faceAmount` (quoteBots, same config source as botCreateBillOrder). */
  quote(bc: BotContext, biller: BillerKey, faceAmount: number): Promise<{ payAmount: number }>
  createOrder(bc: BotContext, input: BotBillOrderInput): Promise<BotOrderResult>
  /** Id of the bot order this buyer already created from verify `token` (orphan check after a throw), or null. */
  findOrderId(bc: BotContext, token: string): Promise<string | null>
}

type PbSession = UzoBotSession & UzoPbSessionFields
const money = (n: number) => n.toFixed(2)
/** Masked names from Hubtel: printable ASCII and the Uzo wording rule (no data / bundle words). */
const nameText = (n: string | null | undefined) => (n ? ascii(uzoSafeLabel(n)) : "")

// ── Screens ──────────────────────────────────────────────────────────────────

function billerScreen(ctx: UzoBotCtx, billers: PbBiller[] | { key: string }[], prefix = ""): string {
  const lines = billers.filter(b => ussdBiller(b.key)).map((b, i) => `${i + 1}. ${labelOf(b.key)}\n`).join("")
  return `${prefix}${uzoShopHeader(ctx)}Pay Bills\n${lines}0. Back`
}

const ecgModeScreen = (prefix = "") => `${prefix}ECG\n1. This number\n2. Other number\n3. Meter number\n0. Back`

const ACCOUNT_PROMPT: Record<UzoPbAccountStage, (s: PbSession) => string> = {
  phone: () => "Enter the phone number linked to the meter:",
  meter: () => "Enter meter number:",
  account: s => (s.pbBiller === "startimes" ? "Enter account number:" : "Enter smartcard number:"),
  landline: () => "Enter the landline number (e.g. 0302450262):",
  broadband: () => "Enter the broadband account number:",
}
const accountScreen = (s: PbSession, stage: UzoPbAccountStage, prefix = "") => `${prefix}${ACCOUNT_PROMPT[stage](s)}\n0. Back`

/**
 * Meter, then due, then name: a long line loses the name's words first. The due is ONE word ("Due:12.50"), so the
 * word cut either keeps it whole or drops it whole: never a bare "Due" or a cut amount.
 */
const meterLabel = (m: UzoPbMeter) =>
  [m.m, m.o !== null && m.o > 0 ? `Due:${money(m.o)}` : "", nameText(m.n)].filter(Boolean).join(" ")

const meterTypeScreen = (meter: string, prefix = "") => `${prefix}Meter ${meter}\nMeter type:\n1. Prepaid\n2. Postpaid\n0. Back`

/** Consent before an unlinked meter is linked to the phone (only "1" links it). */
export const pbConsentScreen = (meter: string, phone: string) =>
  `Meter ${meter} is not linked to ${phone}.\n1. Yes, link meter ${meter} to ${phone}\n2. Cancel\n0. Back`

const MIN_NAME = 4

/**
 * Amount prompt, at most 160 chars with the prompt and "0. Back" always whole: when too long the name is shortened
 * first (dropped below 4 chars), then the account.
 */
export function pbAmountScreen(s: UzoPbSessionFields, prefix = ""): string {
  let name = nameText(s.pbName).slice(0, 40).trim()
  let account = s.pbAccount ?? ""
  const due = s.pbDue !== null && s.pbDue !== undefined && s.pbDue > 0 ? [`Due: GHS ${money(s.pbDue)}`] : []
  const render = () => [
    `${prefix}${labelOf(s.pbBiller)} ${account}`.trimEnd(),
    ...(name ? [`Name: ${name}`] : []),
    ...due,
    `Enter amount (GHS ${money(s.pbMin ?? 0)} - ${money(s.pbMax ?? 0)}):`,
    "0. Back",
  ].join("\n")
  let text = render()
  let over = text.length - UZO_SCREEN_LIMIT
  if (over > 0 && name) {
    name = name.length - over >= MIN_NAME ? name.slice(0, name.length - over).trim() : ""
    text = render()
    over = text.length - UZO_SCREEN_LIMIT
  }
  if (over > 0 && account) {
    account = account.slice(0, Math.max(0, account.length - over))
    text = render()
  }
  return text
}

/** Confirm: "Pay GHS x (was GHS face)" / what the biller gets on which account / the MoMo number. */
export function pbConfirmScreen(ctx: UzoBotCtx, s: UzoPbSessionFields): string {
  const type = s.pbBiller === "ecg" && s.pbMeterType ? (s.pbMeterType === "prepaid" ? " Prepaid" : " Postpaid") : ""
  const face = s.pbFace ?? 0
  const body = uzoConfirmText({
    pay: s.pbPay ?? 0, face, receive: `GHS ${money(face)} ${labelOf(s.pbBiller)}${type} on ${s.pbAccount ?? ""}`,
    payer: normalizeGhanaPhone(ctx.dialingPhone) ?? ctx.dialingPhone,
  })
  const head = uzoShopHeader(ctx)
  return head && fitsUzo(head + body) ? head + body : body
}

// ── Flow ─────────────────────────────────────────────────────────────────────

type Step = { ctx: UzoBotCtx; input: string; s: PbSession; d: PayBillsDeps }

/** Every pb* field except the biller list cleared (a fresh biller choice never inherits an account or price). */
const CLEARED: Partial<UzoPbSessionFields> = {
  pbBiller: undefined, pbMin: undefined, pbMax: undefined, pbEcgMode: undefined, pbStage: undefined, pbPhone: undefined,
  pbLandline: undefined, pbAccount: undefined, pbMeterType: undefined, pbMeters: undefined, pbPage: undefined,
  pbToken: undefined, pbName: undefined, pbDue: undefined, pbFace: undefined, pbPay: undefined,
}

async function goto(x: Step, patch: Partial<UzoPbSessionFields> & { step: UzoBotSession["step"] }, text: string): Promise<UzoResponse> {
  x.s = { ...x.s, ...patch } as PbSession
  await x.d.io.save(x.ctx.sessionId, x.s)
  return x.d.io.cont(text)
}
const finish = (x: Step, text: string) => x.d.io.end(text)

export async function startPayBills(
  ctx: UzoBotCtx, session: UzoBotSession, d: PayBillsDeps = livePayBillsDeps(ctx.surface),
): Promise<UzoResponse> {
  if (!uzoBotContext(ctx)) return d.io.end(UZO_BOT_UNAVAILABLE) // shop menu without a resolved shop: fail closed
  let billers: PbBiller[]
  try {
    billers = (await d.billers()).filter(b => ussdBiller(b.key))
  } catch (e) {
    console.error(`[${TAG}] billers failed:`, e instanceof Error ? e.message : "error")
    return d.io.end(UZO_BOT_UNAVAILABLE)
  }
  if (billers.length === 0) return d.io.end(PB_TEXT.notAvailable)
  const list = billers.map(b => ({ key: b.key, min: b.min, max: b.max }))
  await d.io.save(ctx.sessionId, { ...withoutBotFields(session), step: "PB_BILLER", pbBillers: list } as UzoBotSession)
  return d.io.cont(billerScreen(ctx, list))
}

export async function handlePayBillsStep(
  ctx: UzoBotCtx, input: string, session: UzoBotSession, d: PayBillsDeps = livePayBillsDeps(ctx.surface),
): Promise<UzoResponse> {
  const x: Step = { ctx, input: (input ?? "").trim(), s: session as PbSession, d }
  if (!uzoBotContext(ctx)) return d.io.end(UZO_BOT_UNAVAILABLE)
  switch (session.step) {
    case "PB_BILLER": return selectBiller(x)
    case "PB_ECG_MODE": return selectEcgMode(x)
    case "PB_ACCOUNT": return enterAccount(x)
    case "PB_METERS": return selectMeter(x)
    case "PB_METER_TYPE": return selectMeterType(x)
    case "PB_CONSENT": return giveConsent(x)
    case "PB_AMOUNT": return enterAmount(x)
    case "PB_CONFIRM": return confirm(x)
    default: return d.io.leave(ctx, session)
  }
}

const shownBillers = (s: PbSession) => (s.pbBillers ?? []).filter(b => ussdBiller(b.key))

const toBillers = (x: Step, prefix = "") => goto(x, { ...CLEARED, step: "PB_BILLER" }, billerScreen(x.ctx, shownBillers(x.s), prefix))
const toEcgMode = (x: Step, prefix = "") =>
  goto(x, { step: "PB_ECG_MODE", pbMeters: undefined, pbPage: undefined, pbToken: undefined }, ecgModeScreen(prefix))
const toStage = (x: Step, stage: UzoPbAccountStage, patch: Partial<UzoPbSessionFields> = {}, prefix = "") =>
  goto(x, { ...patch, step: "PB_ACCOUNT", pbStage: stage }, accountScreen({ ...x.s, ...patch }, stage, prefix))
const toAmount = (x: Step, patch: Partial<UzoPbSessionFields>, prefix = "") =>
  goto(x, { ...patch, step: "PB_AMOUNT", pbFace: undefined, pbPay: undefined }, pbAmountScreen({ ...x.s, ...patch }, prefix))

async function selectBiller(x: Step): Promise<UzoResponse> {
  if (x.input === "0") return x.d.io.leave(x.ctx, withoutBotFields(x.s))
  const billers = shownBillers(x.s)
  const b = /^\d$/.test(x.input) ? billers[Number(x.input) - 1] : undefined
  if (!b || !ussdBiller(b.key)) return goto(x, { step: "PB_BILLER" }, billerScreen(x.ctx, billers))
  const base = { ...CLEARED, pbBiller: b.key, pbMin: b.min, pbMax: b.max }
  if (b.key === "ecg") return goto(x, { ...base, step: "PB_ECG_MODE" }, ecgModeScreen())
  return toStage(x, b.key === "telecel_broadband" ? "landline" : "account", base)
}

async function selectEcgMode(x: Step): Promise<UzoResponse> {
  const own = normalizeGhanaPhone(x.ctx.dialingPhone)
  switch (x.input) {
    case "0": return toBillers(x)
    case "1": return own ? lookupMeters(x, own, "self") : finish(x, UZO_BOT_UNAVAILABLE)
    case "2": return toStage(x, "phone", { pbEcgMode: "other" })
    case "3": return own ? toStage(x, "meter", { pbEcgMode: "meter", pbPhone: own, pbMeters: undefined }) : finish(x, UZO_BOT_UNAVAILABLE)
    default: return goto(x, { step: "PB_ECG_MODE" }, ecgModeScreen())
  }
}

/** botVerifyBill; a throw is reported as a 503 (never shown). */
async function verify(x: Step, bc: BotContext, input: PbVerifyInput): Promise<VerifyResult> {
  try {
    return await x.d.verify(bc, input)
  } catch (e) {
    console.error(`[${TAG}] verify threw:`, e instanceof Error ? e.message : "error")
    return { ok: false, status: 503, error: "error" }
  }
}

/** Fixed text for a failed lookup (never the provider's message): 422/400 => retry screen, 429/403/other => end. */
async function verifyFailed(x: Step, r: { status: number }, retry: (prefix: string) => Promise<UzoResponse>): Promise<UzoResponse> {
  if (r.status === 422) return retry(PB_TEXT.verifyFailed + "\n")
  if (r.status === 400) return retry(PB_TEXT.invalidDetails + "\n")
  return finish(x, botErrorText(r.status))
}

const toMeters = (r: Extract<VerifyResult, { ok: true }>): UzoPbMeter[] =>
  (r.meters ?? []).map(m => ({ m: m.meter, n: m.name, o: m.outstanding, t: m.token }))

/** ECG meters linked to `phone`: a list to pick from, or (none) the meter-number entry. */
async function lookupMeters(x: Step, phone: string, mode: "self" | "other"): Promise<UzoResponse> {
  const bc = uzoBotContext(x.ctx)
  if (!bc) return finish(x, UZO_BOT_UNAVAILABLE)
  const r = await verify(x, bc, { biller: "ecg", phone })
  if (!r.ok) return verifyFailed(x, r, p => (mode === "self" ? toEcgMode(x, p) : toStage(x, "phone", { pbEcgMode: "other" }, p)))
  const meters = toMeters(r)
  const patch = { pbEcgMode: mode, pbPhone: phone, pbMeters: meters }
  if (meters.length === 0) return toStage(x, "meter", patch, `No meters linked to ${phone}.\n`)
  return showMeters(x, 0, patch)
}

/** Show meter page `page`, clamped into range. */
function showMeters(x: Step, page: number, patch: Partial<UzoPbSessionFields> = {}): Promise<UzoResponse> {
  const meters = patch.pbMeters ?? x.s.pbMeters ?? []
  const last = Math.max(0, Math.ceil(meters.length / PB_PAGE_SIZE) - 1)
  const p = Math.min(Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0), last)
  const list = uzoPagedList(meters, p, meterLabel, { header: "Select meter:", pageSize: PB_PAGE_SIZE })
  return goto(x, { ...patch, step: "PB_METERS", pbPage: p }, list.text)
}

async function selectMeter(x: Step): Promise<UzoResponse> {
  const meters = x.s.pbMeters ?? []
  const last = Math.max(0, Math.ceil(meters.length / PB_PAGE_SIZE) - 1)
  const page = Math.min(Math.max(0, x.s.pbPage ?? 0), last)
  if (x.input === "0") return page > 0 ? showMeters(x, page - 1) : toEcgMode(x)
  const offset = page * PB_PAGE_SIZE
  const onPage = meters.slice(offset, offset + PB_PAGE_SIZE)
  const n = /^\d+$/.test(x.input) ? Number(x.input) : NaN
  // "More..." is numbered right after this page's meters (showMeters clamps, so past the end it repaints).
  if (n === offset + onPage.length + 1) return showMeters(x, page + 1)
  const m = n > offset && n <= offset + onPage.length ? onPage[n - offset - 1] : undefined
  if (!m) return showMeters(x, x.s.pbPage ?? 0)
  return toAmount(x, { pbAccount: m.m, pbToken: m.t, pbName: m.n, pbDue: m.o, pbMeterType: undefined })
}

async function enterAccount(x: Step): Promise<UzoResponse> {
  const s = x.s
  const stage = s.pbStage ?? "account"
  const retry = (prefix: string) => goto(x, { step: "PB_ACCOUNT" }, accountScreen(s, stage, prefix))
  if (x.input === "0") {
    if (stage === "phone" || stage === "meter") return toEcgMode(x)
    if (stage === "broadband") return toStage(x, "landline")
    return toBillers(x)
  }
  const value = x.input.replace(/\s+/g, "")
  const biller = s.pbBiller
  if (!ussdBiller(biller)) return finish(x, UZO_BOT_UNAVAILABLE)

  if (stage === "phone") {
    const local = normalizeGhanaPhone(value)
    if (!local || !isValidGhanaMobile(local)) return retry(PB_TEXT.invalidPhone + "\n")
    return lookupMeters(x, local, "other")
  }
  if (stage === "meter") {
    const n = normaliseInputs("ecg", { phone: s.pbPhone, account: value })
    if (!n.ok || !n.value.account) return retry(PB_TEXT.invalidMeter + "\n")
    return goto(x, { step: "PB_METER_TYPE", pbAccount: n.value.account, pbMeterType: undefined }, meterTypeScreen(n.value.account))
  }
  if (stage === "landline") {
    if (!/^0\d{9}$/.test(value)) return retry(PB_TEXT.invalidLandline + "\n")
    return toStage(x, "broadband", { pbLandline: value })
  }
  const inputs = stage === "broadband" ? { account: s.pbLandline, broadbandAccount: value } : { account: value }
  const n = normaliseInputs(biller, inputs)
  if (!n.ok) return retry(PB_TEXT.invalidDetails + "\n")
  const bc = uzoBotContext(x.ctx)
  if (!bc) return finish(x, UZO_BOT_UNAVAILABLE)
  const r = await verify(x, bc, { biller, ...inputs })
  if (!r.ok) return verifyFailed(x, r, retry)
  if (!r.token) return finish(x, UZO_BOT_UNAVAILABLE)
  return toAmount(x, { pbAccount: n.value.account, pbToken: r.token, pbName: r.customerName, pbDue: r.amountDue })
}

async function selectMeterType(x: Step): Promise<UzoResponse> {
  const s = x.s
  if (x.input === "0") return toStage(x, "meter")
  const type = x.input === "1" ? "prepaid" : x.input === "2" ? "postpaid" : undefined
  if (!type || !s.pbAccount || !s.pbPhone) return goto(x, { step: "PB_METER_TYPE" }, meterTypeScreen(s.pbAccount ?? ""))
  const bc = uzoBotContext(x.ctx)
  if (!bc) return finish(x, UZO_BOT_UNAVAILABLE)
  // A meter typed directly may already be linked to the phone: then its own token is used (no consent needed).
  let meters = s.pbMeters
  if (meters === undefined) {
    const r = await verify(x, bc, { biller: "ecg", phone: s.pbPhone })
    if (!r.ok) return verifyFailed(x, r, p => goto(x, { step: "PB_METER_TYPE" }, meterTypeScreen(s.pbAccount!, p)))
    meters = toMeters(r)
  }
  const hit = meters.find(m => m.m.toLowerCase() === s.pbAccount!.toLowerCase())
  if (hit) return toAmount(x, { pbMeterType: type, pbMeters: meters, pbAccount: hit.m, pbToken: hit.t, pbName: hit.n, pbDue: hit.o })
  return goto(x, { step: "PB_CONSENT", pbMeterType: type, pbMeters: meters }, pbConsentScreen(s.pbAccount, s.pbPhone))
}

/** The meter is linked (addMeter + consent) ONLY on an explicit "1" here. */
async function giveConsent(x: Step): Promise<UzoResponse> {
  const s = x.s
  if (x.input === "0") return goto(x, { step: "PB_METER_TYPE" }, meterTypeScreen(s.pbAccount ?? ""))
  if (x.input === "2") return finish(x, PB_TEXT.cancelled)
  if (x.input !== "1" || !s.pbAccount || !s.pbPhone) {
    return goto(x, { step: "PB_CONSENT" }, pbConsentScreen(s.pbAccount ?? "", s.pbPhone ?? ""))
  }
  const bc = uzoBotContext(x.ctx)
  if (!bc) return finish(x, UZO_BOT_UNAVAILABLE)
  const r = await verify(x, bc, { biller: "ecg", phone: s.pbPhone, account: s.pbAccount, addMeter: true, consent: true })
  if (!r.ok) return verifyFailed(x, r, p => toStage(x, "meter", {}, p))
  if (!r.token) return finish(x, UZO_BOT_UNAVAILABLE)
  return toAmount(x, { pbToken: r.token, pbName: r.customerName, pbDue: r.amountDue })
}

async function enterAmount(x: Step): Promise<UzoResponse> {
  const s = x.s
  if (x.input === "0") return toBillers(x)
  const min = s.pbMin ?? 0
  const max = s.pbMax ?? 0
  const amount = isValidAmountInput(x.input) ? Number(x.input) : NaN
  if (!(amount > 0) || amount < min || amount > max) {
    return goto(x, { step: "PB_AMOUNT" }, pbAmountScreen(s, `Enter an amount from GHS ${money(min)} to GHS ${money(max)}.\n`))
  }
  const bc = uzoBotContext(x.ctx)
  const biller = s.pbBiller
  if (!bc || !ussdBiller(biller) || !s.pbToken) return finish(x, UZO_BOT_UNAVAILABLE)
  const face = Math.round(amount * 100) / 100
  let pay: number
  try {
    pay = (await x.d.quote(bc, biller, face)).payAmount
  } catch (e) {
    console.error(`[${TAG}] quote failed:`, e instanceof Error ? e.message : "error")
    return finish(x, UZO_BOT_UNAVAILABLE)
  }
  if (!(pay > 0)) return finish(x, UZO_BOT_UNAVAILABLE)
  const patch = { pbFace: face, pbPay: pay }
  return goto(x, { ...patch, step: "PB_CONFIRM" }, pbConfirmScreen(x.ctx, { ...s, ...patch }))
}

async function confirm(x: Step): Promise<UzoResponse> {
  const { s, d, ctx } = x
  if (x.input === "2") return finish(x, PB_TEXT.cancelled)
  if (x.input === "0") return toAmount(x, {})
  if (x.input !== "1") return goto(x, { step: "PB_CONFIRM" }, pbConfirmScreen(ctx, s))

  const bc = uzoBotContext(ctx)
  const token = s.pbToken
  const face = s.pbFace ?? 0
  const pay = s.pbPay ?? 0
  if (!bc || !token || !ussdBiller(s.pbBiller) || !(face > 0) || !(pay > 0)) return finish(x, UZO_BOT_UNAVAILABLE)

  // Close the flow BEFORE the engine call (whatever it answers, or if it throws): the token is gone from the
  // session, so no back-navigation on it can reach a confirm and create a second order.
  await d.io.save(ctx.sessionId, uzoBotClosedSession(ctx, s))
  // The engine dedupes on the verify token: a retried confirm with this session's token returns the same order.
  let r: BotOrderResult
  try {
    r = await d.createOrder(bc, { token, amount: face, expectedPay: pay })
  } catch (e) {
    console.error(`[${TAG}] createOrder threw:`, e instanceof Error ? e.message : "error")
    // It may have committed before throwing: an order from this token would sit pending + unpaid, never charged.
    const orphan = await d.findOrderId(bc, token).catch(() => null)
    if (orphan) await d.failOrder(orphan)
    return finish(x, UZO_BOT_UNAVAILABLE)
  }
  if (!r.ok) {
    // The verify token expired (or no longer verifies) between the lookup and confirm: only a new lookup helps.
    if (r.status === 400 && r.error === BOT_BILL_TOKEN_EXPIRED) return finish(x, UZO_BOT_RESTART)
    return finish(x, botErrorText(r.status))
  }
  // A replay under the same verify token hands back an older order: never charge what the screen did not show.
  if (!samePrice(r.order.payAmount, pay) || !samePrice(r.order.faceAmount, face)) {
    console.error(`[${TAG}] engine order differs from the confirm screen; refusing to charge:`, r.order.id)
    return finish(x, botErrorText(409))
  }
  return finish(x, await uzoChargeOrder(d, ctx, "cs_bill", r.order.id, TAG))
}

// ── Live wiring ──────────────────────────────────────────────────────────────

let runtime: ReturnType<typeof getBotBillsRuntime> | null = null
const bills = () => (runtime ??= getBotBillsRuntime())

export function livePayBillsDeps(surface: UzoBotCtx["surface"]): PayBillsDeps {
  return {
    io: liveUzoBotIo(surface),
    async billers() {
      const cfg = await bills().deps.getBillsConfig()
      if (!cfg.enabled) return []
      return BILLER_KEYS.filter(k => cfg.billers[k]?.enabled).map(k => ({ key: k, min: cfg.billers[k].min, max: cfg.billers[k].max }))
    },
    verify: (bc, input) => botVerifyBill(bills().deps, bc, input),
    async quote(bc, biller, faceAmount) {
      const cfg = await bills().deps.getCashbackConfig()
      return quoteBots({ serviceKey: BILLERS[biller].serviceKey, provider: "hubtel", faceAmount, rail: bc.rail, shop: !!bc.shopId }, cfg)
    },
    createOrder: (bc, input) => botCreateBillOrder(bills().deps, bc, input),
    async findOrderId(bc, token) {
      const c = resolveBotContext(bc)
      if (!c.ok) return null
      const row = await bills().deps.findBotBillOrderByHash(c.ctx.botSurface, c.ctx.buyerPhone, billTokenHash(token))
      return row?.id ?? null
    },
    async readOrder(id) {
      const { data, error } = await bills().db.from("hubtel_bill_orders").select("status, payment_status").eq("id", id).maybeSingle()
      if (error) throw error
      return (data as { status?: string; payment_status?: string } | null) ?? null
    },
    failOrder: (id) => failBotCharge(bills().db, "cs_bill", id, null, TAG),
    charge: (i) => botChargeMomo(getBotMomoRuntime(), i),
  }
}
