// "Pay Bills" (Commission Cashback bots): Utility Bills looked up with the bot engine (botVerifyBill: masked names,
// tokens bound to this bot + shop), priced with quoteBots on rail paystack, ordered with botCreateBillOrder (unpaid,
// deduped on the verify token) and paid by a MoMo prompt.
// - Uzo menus (UZO_PROFILE): the main USSD (surface "ussd", no shop) and the shop USSD (surface "ussd_shop", the
//   session's resolved shop); the dialing number pays; Ghana Water is never offered (the engine refuses it on USSD).
// - WhatsApp bots (WHATSAPP_PROFILE): names as sent, 10 per page, Ghana Water offered (meter, linked mobile, email:
//   PB_EMAIL, the storefront bills validator), the buyer types the MoMo number (PB_PAY_PHONE, before confirm) and
//   NEEDS_VERIFY => SMS code (PB_PAY_VERIFY).
// Pattern: lib/ussd-hubtel/flows/pay-bills.ts (same steps and rules, Uzo text conventions).
import {
  isValidAmountInput, isValidBillAccount, isValidBillEmail, normaliseInputs, BILLERS, BILLER_KEYS, type BillerKey, type BillInputs,
} from "@/lib/bills/billers"
import { billTokenHash, type VerifyResult } from "@/lib/bills/service"
import { quoteBots } from "@/lib/cashback/quote"
import { resolveBotContext, type BotContext } from "@/lib/bot-commission/context"
import { botChargeMomo, getBotMomoRuntime } from "@/lib/bot-commission/momo"
import { failBotCharge } from "@/lib/bot-commission/momo-fail"
import { botCreateBillOrder, BOT_BILL_TOKEN_EXPIRED, type BotBillOrderInput, type BotOrderResult } from "@/lib/bot-commission/orders"
import { sendPayerOtp, verifyPayerOtp } from "@/lib/bot-commission/payer-verify"
import { getBotBillsRuntime } from "@/lib/bot-commission/runtime"
import { botVerifyBill } from "@/lib/bot-commission/verify"
import { isValidGhanaMobile, normalizeGhanaPhone } from "@/lib/phone-format"
import type { UzoPbAccountStage, UzoPbMeter, UzoPbSessionFields, UzoResponse } from "../types"
import {
  botFlowChargeOrder, botFlowContext, botRestartText, endBotFlow, flowProfile, liveUzoBotIo, parsePayPhone, payerVerifyStep,
  samePrice, startPayerVerify, uzoBotClosedSession, uzoShopHeader, withoutBotFields, PAY_PHONE_INVALID, PAY_PHONE_PROMPT,
  UZO_BOT_UNAVAILABLE, type BotFlowCtx, type UzoBotIo, type UzoBotPayDeps, type UzoBotSession,
} from "./kit"
import { UZO_PROFILE, type BotFlowProfile } from "./profile"
import { botErrorText, uzoConfirmText, uzoPagedList } from "./screen"

export type { UzoBotCtx, UzoBotSession } from "./kit"

/** Uzo page size (the WhatsApp profile pages 10). */
export const PB_PAGE_SIZE = UZO_PROFILE.pageSize
const TAG = "USSD-PB"

/** Billers offered on the Uzo menus, in menu order, with their short names. Ghana Water is deliberately absent. */
export const PB_BILLER_LABEL: Partial<Record<BillerKey, string>> = {
  ecg: "ECG", dstv: "DStv", gotv: "GOtv", startimes: "StarTimes", telecel_broadband: "Telecel Broadband",
}
/** WhatsApp adds Ghana Water (it needs an email, which only the chat can carry). */
const WA_BILLER_LABEL: Partial<Record<BillerKey, string>> = { ...PB_BILLER_LABEL, ghana_water: "Ghana Water" }
const labelsOf = (p: BotFlowProfile) => (p.allowGhanaWater ? WA_BILLER_LABEL : PB_BILLER_LABEL)
/** A biller this profile offers. */
const offered = (p: BotFlowProfile, k: unknown): k is BillerKey =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(labelsOf(p), k)
const labelOf = (p: BotFlowProfile, k: string | undefined) => (offered(p, k) ? labelsOf(p)[k]! : "Bill")

export const PB_TEXT = {
  notAvailable: botErrorText(403),
  verifyFailed: "Could not verify this account. Check and try again.",
  invalidDetails: "Invalid details. Check and try again.",
  invalidPhone: "Invalid number.",
  invalidMeter: "Enter a valid meter number.",
  invalidLandline: "Enter the 10-digit landline.",
  invalidEmail: "Enter a valid email.",
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
/** Masked names from Hubtel: Uzo => printable ASCII + the wording rule; WhatsApp => as sent. */
const nameText = (p: BotFlowProfile, n: string | null | undefined) => (n ? p.label(n) : "")

// ── Screens ──────────────────────────────────────────────────────────────────

function billerScreen(ctx: BotFlowCtx, p: BotFlowProfile, billers: PbBiller[] | { key: string }[], prefix = ""): string {
  const lines = billers.filter(b => offered(p, b.key)).map((b, i) => `${i + 1}. ${labelOf(p, b.key)}\n`).join("")
  return `${prefix}${uzoShopHeader(ctx)}Pay Bills\n${lines}0. Back`
}

const ecgModeScreen = (prefix = "") => `${prefix}ECG\n1. This number\n2. Other number\n3. Meter number\n0. Back`

const ACCOUNT_PROMPT: Record<UzoPbAccountStage, (s: PbSession) => string> = {
  phone: () => "Enter the phone number linked to the meter:",
  meter: () => "Enter meter number:",
  account: s => (s.pbBiller === "startimes" ? "Enter account number:" : s.pbBiller === "ghana_water" ? "Enter meter number:" : "Enter smartcard number:"),
  landline: () => "Enter the landline number (e.g. 0302450262):",
  broadband: () => "Enter the broadband account number:",
  water_phone: () => "Enter the phone number linked to the meter:",
}
const accountScreen = (s: PbSession, stage: UzoPbAccountStage, prefix = "") => `${prefix}${ACCOUNT_PROMPT[stage](s)}\n0. Back`
const emailScreen = (prefix = "") => `${prefix}Enter your email address (Ghana Water requires it):\n0. Back`
const payPhoneScreen = (prefix = "") => `${prefix}${PAY_PHONE_PROMPT}`

/**
 * Meter, then due, then name: a long line loses the name's words first. The due is ONE word ("Due:12.50"), so the
 * word cut either keeps it whole or drops it whole: never a bare "Due" or a cut amount.
 */
const meterLabel = (p: BotFlowProfile) => (m: UzoPbMeter) =>
  [m.m, m.o !== null && m.o > 0 ? `Due:${money(m.o)}` : "", nameText(p, m.n)].filter(Boolean).join(" ")

const meterTypeScreen = (meter: string, prefix = "") => `${prefix}Meter ${meter}\nMeter type:\n1. Prepaid\n2. Postpaid\n0. Back`

/** Consent before an unlinked meter is linked to the phone (only "1" links it). */
export const pbConsentScreen = (meter: string, phone: string) =>
  `Meter ${meter} is not linked to ${phone}.\n1. Yes, link meter ${meter} to ${phone}\n2. Cancel\n0. Back`

const MIN_NAME = 4

/**
 * Amount prompt, at most the profile's limit (Uzo 160) with the prompt and "0. Back" always whole: when too long the
 * name is shortened first (dropped below 4 chars), then the account.
 */
export function pbAmountScreen(s: UzoPbSessionFields, prefix = "", p: BotFlowProfile = UZO_PROFILE): string {
  let name = nameText(p, s.pbName).slice(0, 40).trim()
  let account = s.pbAccount ?? ""
  const due = s.pbDue !== null && s.pbDue !== undefined && s.pbDue > 0 ? [`Due: GHS ${money(s.pbDue)}`] : []
  const render = () => [
    `${prefix}${labelOf(p, s.pbBiller)} ${account}`.trimEnd(),
    ...(name ? [`Name: ${name}`] : []),
    ...due,
    `Enter amount (GHS ${money(s.pbMin ?? 0)} - ${money(s.pbMax ?? 0)}):`,
    "0. Back",
  ].join("\n")
  let text = render()
  let over = text.length - p.limit
  if (over > 0 && name) {
    name = name.length - over >= MIN_NAME ? name.slice(0, name.length - over).trim() : ""
    text = render()
    over = text.length - p.limit
  }
  if (over > 0 && account) {
    account = account.slice(0, Math.max(0, account.length - over))
    text = render()
  }
  return text
}

/**
 * Confirm: "Pay GHS x (was GHS face)" / what the biller gets on which account / the MoMo number (Uzo: the dialling
 * number; WhatsApp: the number the buyer typed).
 */
export function pbConfirmScreen(ctx: BotFlowCtx, s: UzoPbSessionFields): string {
  const p = flowProfile(ctx) ?? UZO_PROFILE
  const type = s.pbBiller === "ecg" && s.pbMeterType ? (s.pbMeterType === "prepaid" ? " Prepaid" : " Postpaid") : ""
  const face = s.pbFace ?? 0
  const body = uzoConfirmText({
    pay: s.pbPay ?? 0, face, receive: `GHS ${money(face)} ${labelOf(p, s.pbBiller)}${type} on ${s.pbAccount ?? ""}`,
    payer: p.askPayPhone ? s.pbPayPhone ?? "" : normalizeGhanaPhone(ctx.dialingPhone) ?? ctx.dialingPhone,
    limit: p.limit,
  })
  const head = uzoShopHeader(ctx)
  return head && (head + body).length <= p.limit ? head + body : body
}

// ── Flow ─────────────────────────────────────────────────────────────────────

type Step = { ctx: BotFlowCtx; p: BotFlowProfile; input: string; s: PbSession; d: PayBillsDeps }

/** Every pb* field except the biller list cleared (a fresh biller choice never inherits an account or price). */
const CLEARED: Partial<UzoPbSessionFields> = {
  pbBiller: undefined, pbMin: undefined, pbMax: undefined, pbEcgMode: undefined, pbStage: undefined, pbPhone: undefined,
  pbLandline: undefined, pbAccount: undefined, pbMeterType: undefined, pbMeters: undefined, pbPage: undefined,
  pbToken: undefined, pbName: undefined, pbDue: undefined, pbFace: undefined, pbPay: undefined,
  pbEmail: undefined, pbPayPhone: undefined, pbOrderId: undefined,
}

async function goto(x: Step, patch: Partial<UzoPbSessionFields> & { step: UzoBotSession["step"] }, text: string): Promise<UzoResponse> {
  x.s = { ...x.s, ...patch } as PbSession
  await x.d.io.save(x.ctx.sessionId, x.s)
  return x.d.io.cont(text)
}
/** Terminal exit (WhatsApp: the closed session is saved first, so a later "1" never reaches a stale confirm; Uzo: unchanged). */
const finish = (x: Step, text: string) => endBotFlow(x.d.io, x.ctx, x.s, text)

export async function startPayBills(
  ctx: BotFlowCtx, session: UzoBotSession, d: PayBillsDeps = livePayBillsDeps(ctx.surface),
): Promise<UzoResponse> {
  const p = flowProfile(ctx)
  if (!p || !botFlowContext(ctx)) return d.io.end(UZO_BOT_UNAVAILABLE) // shop without a resolved shop: fail closed
  let billers: PbBiller[]
  try {
    billers = (await d.billers()).filter(b => offered(p, b.key))
  } catch (e) {
    console.error(`[${TAG}] billers failed:`, e instanceof Error ? e.message : "error")
    return d.io.end(UZO_BOT_UNAVAILABLE)
  }
  if (billers.length === 0) return d.io.end(PB_TEXT.notAvailable)
  const list = billers.map(b => ({ key: b.key, min: b.min, max: b.max }))
  await d.io.save(ctx.sessionId, { ...withoutBotFields(session), step: "PB_BILLER", pbBillers: list } as UzoBotSession)
  return d.io.cont(billerScreen(ctx, p, list))
}

export async function handlePayBillsStep(
  ctx: BotFlowCtx, input: string, session: UzoBotSession, d: PayBillsDeps = livePayBillsDeps(ctx.surface),
): Promise<UzoResponse> {
  const p = flowProfile(ctx)
  if (!p || !botFlowContext(ctx)) return endBotFlow(d.io, ctx, session, UZO_BOT_UNAVAILABLE)
  const x: Step ={ ctx, p, input: (input ?? "").trim(), s: session as PbSession, d }
  switch (session.step) {
    case "PB_BILLER": return selectBiller(x)
    case "PB_ECG_MODE": return selectEcgMode(x)
    case "PB_ACCOUNT": return enterAccount(x)
    case "PB_EMAIL": return p.allowGhanaWater ? enterEmail(x) : d.io.leave(ctx, session)
    case "PB_METERS": return selectMeter(x)
    case "PB_METER_TYPE": return selectMeterType(x)
    case "PB_CONSENT": return giveConsent(x)
    case "PB_AMOUNT": return enterAmount(x)
    case "PB_PAY_PHONE": return p.askPayPhone ? enterPayPhone(x) : d.io.leave(ctx, session)
    case "PB_CONFIRM": return confirm(x)
    case "PB_PAY_VERIFY": return p.askPayPhone ? payVerify(x) : d.io.leave(ctx, session)
    default: return d.io.leave(ctx, session)
  }
}

const shownBillers = (x: Step) => (x.s.pbBillers ?? []).filter(b => offered(x.p, b.key))

const toBillers = (x: Step, prefix = "") => goto(x, { ...CLEARED, step: "PB_BILLER" }, billerScreen(x.ctx, x.p, shownBillers(x), prefix))
const toEcgMode = (x: Step, prefix = "") =>
  goto(x, { step: "PB_ECG_MODE", pbMeters: undefined, pbPage: undefined, pbToken: undefined }, ecgModeScreen(prefix))
const toStage = (x: Step, stage: UzoPbAccountStage, patch: Partial<UzoPbSessionFields> = {}, prefix = "") =>
  goto(x, { ...patch, step: "PB_ACCOUNT", pbStage: stage }, accountScreen({ ...x.s, ...patch }, stage, prefix))
const toAmount = (x: Step, patch: Partial<UzoPbSessionFields>, prefix = "") =>
  goto(x, { ...patch, step: "PB_AMOUNT", pbFace: undefined, pbPay: undefined, pbPayPhone: undefined },
    pbAmountScreen({ ...x.s, ...patch }, prefix, x.p))

async function selectBiller(x: Step): Promise<UzoResponse> {
  if (x.input === "0") return x.d.io.leave(x.ctx, withoutBotFields(x.s))
  const billers = shownBillers(x)
  const b = /^\d$/.test(x.input) ? billers[Number(x.input) - 1] : undefined
  if (!b || !offered(x.p, b.key)) return goto(x, { step: "PB_BILLER" }, billerScreen(x.ctx, x.p, billers))
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
  const bc = botFlowContext(x.ctx)
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
  const size = x.p.pageSize
  const last = Math.max(0, Math.ceil(meters.length / size) - 1)
  const p = Math.min(Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0), last)
  const list = uzoPagedList(meters, p, meterLabel(x.p), { header: "Select meter:", pageSize: size, limit: x.p.limit })
  return goto(x, { ...patch, step: "PB_METERS", pbPage: p }, list.text)
}

async function selectMeter(x: Step): Promise<UzoResponse> {
  const meters = x.s.pbMeters ?? []
  const size = x.p.pageSize
  const last = Math.max(0, Math.ceil(meters.length / size) - 1)
  const page = Math.min(Math.max(0, x.s.pbPage ?? 0), last)
  if (x.input === "0") return page > 0 ? showMeters(x, page - 1) : toEcgMode(x)
  const offset = page * size
  const onPage = meters.slice(offset, offset + size)
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
    if (stage === "water_phone") return toStage(x, "account")
    return toBillers(x)
  }
  const value = x.input.replace(/\s+/g, "")
  const biller = s.pbBiller
  if (!offered(x.p, biller)) return finish(x, UZO_BOT_UNAVAILABLE)

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
  // Ghana Water (WhatsApp only): meter, then the linked mobile, then the email; looked up once all three are in.
  if (biller === "ghana_water") {
    if (stage === "water_phone") {
      const local = normalizeGhanaPhone(value)
      if (!local || !isValidGhanaMobile(local)) return retry(PB_TEXT.invalidPhone + "\n")
      return goto(x, { step: "PB_EMAIL", pbPhone: local, pbEmail: undefined }, emailScreen())
    }
    if (!isValidBillAccount(value)) return retry(PB_TEXT.invalidMeter + "\n")
    return toStage(x, "water_phone", { pbAccount: value, pbPhone: undefined, pbEmail: undefined })
  }
  if (stage === "water_phone") return toBillers(x) // a stale stage for another biller: start over
  const inputs = stage === "broadband" ? { account: s.pbLandline, broadbandAccount: value } : { account: value }
  const n = normaliseInputs(biller, inputs)
  if (!n.ok) return retry(PB_TEXT.invalidDetails + "\n")
  const bc = botFlowContext(x.ctx)
  if (!bc) return finish(x, UZO_BOT_UNAVAILABLE)
  const r = await verify(x, bc, { biller, ...inputs })
  if (!r.ok) return verifyFailed(x, r, retry)
  if (!r.token) return finish(x, UZO_BOT_UNAVAILABLE)
  return toAmount(x, { pbAccount: n.value.account, pbToken: r.token, pbName: r.customerName, pbDue: r.amountDue })
}

/** Ghana Water (WhatsApp only): the buyer's email, checked with the storefront bills validator, then the lookup. */
async function enterEmail(x: Step): Promise<UzoResponse> {
  const s = x.s
  if (s.pbBiller !== "ghana_water" || !s.pbAccount || !s.pbPhone) return toBillers(x)
  if (x.input === "0") return toStage(x, "water_phone", { pbEmail: undefined })
  const email = x.input.trim()
  const inputs = { account: s.pbAccount, phone: s.pbPhone, email }
  // The storefront rule (normaliseInputs), the same check botVerifyBill applies.
  if (!isValidBillEmail(email) || !normaliseInputs("ghana_water", inputs).ok) {
    return goto(x, { step: "PB_EMAIL", pbEmail: undefined }, emailScreen(PB_TEXT.invalidEmail + "\n"))
  }
  const bc = botFlowContext(x.ctx)
  if (!bc) return finish(x, UZO_BOT_UNAVAILABLE)
  const r = await verify(x, bc, { biller: "ghana_water", ...inputs })
  if (!r.ok) return verifyFailed(x, r, p => toStage(x, "account", { pbEmail: undefined }, p))
  if (!r.token) return finish(x, UZO_BOT_UNAVAILABLE)
  return toAmount(x, { pbEmail: email, pbToken: r.token, pbName: r.customerName, pbDue: r.amountDue })
}

async function selectMeterType(x: Step): Promise<UzoResponse> {
  const s = x.s
  if (x.input === "0") return toStage(x, "meter")
  const type = x.input === "1" ? "prepaid" : x.input === "2" ? "postpaid" : undefined
  if (!type || !s.pbAccount || !s.pbPhone) return goto(x, { step: "PB_METER_TYPE" }, meterTypeScreen(s.pbAccount ?? ""))
  const bc = botFlowContext(x.ctx)
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
  const bc = botFlowContext(x.ctx)
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
    return goto(x, { step: "PB_AMOUNT" }, pbAmountScreen(s, `Enter an amount from GHS ${money(min)} to GHS ${money(max)}.\n`, x.p))
  }
  const bc = botFlowContext(x.ctx)
  const biller = s.pbBiller
  if (!bc || !offered(x.p, biller) || !s.pbToken) return finish(x, UZO_BOT_UNAVAILABLE)
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
  // WhatsApp: the MoMo number to charge comes before confirm.
  if (x.p.askPayPhone) return goto(x, { ...patch, step: "PB_PAY_PHONE", pbPayPhone: undefined }, payPhoneScreen())
  return goto(x, { ...patch, step: "PB_CONFIRM" }, pbConfirmScreen(x.ctx, { ...s, ...patch }))
}

/** WhatsApp: the MoMo number to charge (never the sender's own number unless typed). */
async function enterPayPhone(x: Step): Promise<UzoResponse> {
  const s = x.s
  if (!s.pbToken || !(s.pbFace! > 0) || !(s.pbPay! > 0)) return toBillers(x)
  if (x.input === "0") return toAmount(x, {})
  const pay = parsePayPhone(x.input)
  if (!pay) return goto(x, { step: "PB_PAY_PHONE", pbPayPhone: undefined }, payPhoneScreen(`${PAY_PHONE_INVALID}\n`))
  return goto(x, { step: "PB_CONFIRM", pbPayPhone: pay }, pbConfirmScreen(x.ctx, { ...s, pbPayPhone: pay }))
}

async function confirm(x: Step): Promise<UzoResponse> {
  const { s, d, ctx, p } = x
  // WhatsApp: no paying number yet (stale / crafted session) => ask for it, never charge the sender by default.
  const payPhone = p.askPayPhone ? s.pbPayPhone : undefined
  if (p.askPayPhone && !payPhone) return goto(x, { step: "PB_PAY_PHONE" }, payPhoneScreen())
  if (x.input === "2") return finish(x, PB_TEXT.cancelled)
  if (x.input === "0") {
    if (p.askPayPhone) return goto(x, { step: "PB_PAY_PHONE", pbPayPhone: undefined }, payPhoneScreen())
    return toAmount(x, {})
  }
  if (x.input !== "1") return goto(x, { step: "PB_CONFIRM" }, pbConfirmScreen(ctx, s))

  const bc = botFlowContext(ctx)
  const token = s.pbToken
  const face = s.pbFace ?? 0
  const pay = s.pbPay ?? 0
  if (!bc || !token || !offered(p, s.pbBiller) || !(face > 0) || !(pay > 0)) return finish(x, UZO_BOT_UNAVAILABLE)

  // Close the flow BEFORE the engine call (whatever it answers, or if it throws): the token is gone from the
  // session, so no back-navigation on it can reach a confirm and create a second order.
  const closed = uzoBotClosedSession(ctx, s)
  await d.io.save(ctx.sessionId, closed)
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
    if (r.status === 400 && r.error === BOT_BILL_TOKEN_EXPIRED) return finish(x, botRestartText(p))
    return finish(x, botErrorText(r.status))
  }
  // A replay under the same verify token hands back an older order: never charge what the screen did not show.
  if (!samePrice(r.order.payAmount, pay) || !samePrice(r.order.faceAmount, face)) {
    console.error(`[${TAG}] engine order differs from the confirm screen; refusing to charge:`, r.order.id)
    return finish(x, botErrorText(409))
  }
  const out = await botFlowChargeOrder(d, ctx, "cs_bill", r.order.id, TAG, payPhone)
  if (out.kind === "end") return finish(x, out.text)
  // WhatsApp NEEDS_VERIFY: the order stays open; only its id and the paying number are kept (no token).
  const sent = await startPayerVerify(d, ctx, r.order.id, payPhone!, TAG)
  if (!sent.ok) return finish(x, sent.text)
  await d.io.save(ctx.sessionId, { ...closed, step: "PB_PAY_VERIFY", pbOrderId: r.order.id, pbPayPhone: payPhone } as UzoBotSession)
  return d.io.cont(sent.text)
}

/** WhatsApp PB_PAY_VERIFY: the SMS code for the paying number; verified => the SAME order is charged again. */
async function payVerify(x: Step): Promise<UzoResponse> {
  const { s, d, ctx } = x
  const closed = uzoBotClosedSession(ctx, s)
  if (!s.pbOrderId || !s.pbPayPhone) {
    await d.io.save(ctx.sessionId, closed)
    return finish(x, UZO_BOT_UNAVAILABLE)
  }
  const r = await payerVerifyStep(d, ctx, x.input, "cs_bill", s.pbOrderId, s.pbPayPhone, TAG)
  if (r.kind === "retry") return goto(x, { step: "PB_PAY_VERIFY" }, r.text)
  await d.io.save(ctx.sessionId, closed)
  return finish(x, r.text)
}

// ── Live wiring ──────────────────────────────────────────────────────────────

let runtime: ReturnType<typeof getBotBillsRuntime> | null = null
const bills = () => (runtime ??= getBotBillsRuntime())

/** Live deps. The Uzo menus use their own io; a WhatsApp surface must pass the bot's io (there is no default). */
export function livePayBillsDeps(surface: BotFlowCtx["surface"], io: UzoBotIo = liveUzoBotIo(surface)): PayBillsDeps {
  return {
    io,
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
    payer: { send: sendPayerOtp, verify: verifyPayerOtp },
  }
}
