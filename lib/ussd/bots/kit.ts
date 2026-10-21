// Shared glue for the commission-cashback bot flows (Network Plans, Pay Bills) on the Uzo menus (main USSD + shop
// USSD) and the WhatsApp bots (main + shop): the per-surface context and presentation profile, session store /
// screen helpers, the engine context, and the read-back + MoMo charge tail every bot order ends with (plus, on
// WhatsApp, the SMS check of the typed paying number when the charge answers NEEDS_VERIFY).
import type { BotContext } from "@/lib/bot-commission/context"
import type { BotChargeInput, BotChargeResult } from "@/lib/bot-commission/momo"
import type { SendPayerOtpResult, VerifyPayerOtpResult } from "@/lib/bot-commission/payer-verify"
import { isValidGhanaMobile, normalizeGhanaPhone } from "@/lib/phone-format"
import { cont as mainCont, end as mainEnd } from "../menus"
import { setSession as setMainSession } from "../session"
import { cont as shopCont, end as shopEnd, shopHeaderName } from "@/lib/ussd-shop/menus"
import { setSession as setShopSession } from "@/lib/ussd-shop/session"
// The menu handlers (handleMain / handleSelectProduct) import the flows, which import this kit: they are loaded
// lazily in leave() so the modules never form an import-time cycle.
import type { UzoResponse, USSDSession, UzoNpSessionFields, UzoPbSessionFields } from "../types"
import type { USSDShopSession } from "@/lib/ussd-shop/types"
import { UZO_PROFILE, WHATSAPP_PROFILE, type BotFlowProfile } from "./profile"
import { botErrorText } from "./screen"

export type BotFlowSurface = "ussd" | "ussd_shop" | "whatsapp" | "whatsapp_shop"

/**
 * Who is buying, on which bot. `shopId` = the shop the shop session resolved (active only); main bots = null.
 * `dialingPhone` = the session's authenticated number (USSD dialler / WhatsApp sender): the buyer, never charged on
 * WhatsApp unless typed as the MoMo number. `profile` defaults to the surface's own (Uzo on USSD, WhatsApp on
 * WhatsApp); one that does not match the surface fails closed.
 */
export interface BotFlowCtx {
  surface: BotFlowSurface
  sessionId: string
  dialingPhone: string
  shopId: string | null
  shopName?: string
  profile?: BotFlowProfile
}

/** Plan 3 name (Uzo menus); same shape. */
export type UzoBotCtx = BotFlowCtx

const WA_SURFACES: readonly BotFlowSurface[] = ["whatsapp", "whatsapp_shop"]
const SHOP_SURFACES: readonly BotFlowSurface[] = ["ussd_shop", "whatsapp_shop"]
export const isWhatsappSurface = (s: BotFlowSurface): boolean => WA_SURFACES.includes(s)
export const isShopSurface = (s: BotFlowSurface): boolean => SHOP_SURFACES.includes(s)

/** The profile the flow runs with: the surface's own; null (fail closed) for an unknown surface or a mismatch. */
export function flowProfile(ctx: BotFlowCtx): BotFlowProfile | null {
  if (!ctx || !(["ussd", "ussd_shop", "whatsapp", "whatsapp_shop"] as const).includes(ctx.surface)) return null
  const own = isWhatsappSurface(ctx.surface) ? WHATSAPP_PROFILE : UZO_PROFILE
  if (ctx.profile && ctx.profile.kind !== own.kind) return null
  return ctx.profile ?? own
}

/** The menu session a bot flow runs in (main or shop); the flow only adds its own fields. */
export type UzoBotSession = USSDSession | USSDShopSession

/** Session store, screen wrappers and "back to the menu" of the surface the flow runs on. */
export interface UzoBotIo {
  save(sessionId: string, session: UzoBotSession): Promise<void>
  cont(message: string): UzoResponse
  end(message: string): UzoResponse
  /** Leave the flow: back to the main menu (main) or the shop's product menu (shop). */
  leave(ctx: UzoBotCtx, session: UzoBotSession): Promise<UzoResponse>
}

// Typed as full Records so a new flow field cannot be forgotten here (tsc fails until it is listed).
const NP_FIELD_SET: Record<keyof UzoNpSessionFields, true> = {
  npNetwork: true, npCategories: true, npCategory: true, npPage: true, npPlans: true, npPlan: true, npOtherNumber: true,
  npRecipient: true, npPayPhone: true, npOrderId: true, npKey: true,
}
const NP_FIELDS = Object.keys(NP_FIELD_SET) as (keyof UzoNpSessionFields)[]
const PB_FIELD_SET: Record<keyof UzoPbSessionFields, true> = {
  pbBillers: true, pbBiller: true, pbMin: true, pbMax: true, pbEcgMode: true, pbStage: true, pbPhone: true,
  pbLandline: true, pbAccount: true, pbMeterType: true, pbMeters: true, pbPage: true, pbToken: true, pbName: true,
  pbDue: true, pbFace: true, pbPay: true, pbEmail: true, pbPayPhone: true, pbOrderId: true,
}
const PB_FIELDS = Object.keys(PB_FIELD_SET) as (keyof UzoPbSessionFields)[]

/** The session without any bot-flow fields (what the menu had before the flow started). */
export function withoutBotFields<T extends UzoBotSession>(s: T): T {
  const out = { ...s }
  for (const k of NP_FIELDS) delete out[k]
  for (const k of PB_FIELDS) delete out[k]
  return out
}

const mainIo: UzoBotIo = {
  save: (id, s) => setMainSession(id, s as USSDSession),
  cont: mainCont,
  end: mainEnd,
  async leave(ctx, s) {
    const main = s as USSDSession
    const next: USSDSession = { step: "MAIN", dialingPhone: main.dialingPhone ?? ctx.dialingPhone, dataBlocked: main.dataBlocked }
    await setMainSession(ctx.sessionId, next)
    // No digit matches "": handleMain renders the main menu itself (one renderer, same visibility rules).
    const { handleMain } = await import("../handlers/main")
    return handleMain("", ctx.sessionId, next, "ussd")
  },
}

const shopIo: UzoBotIo = {
  save: (id, s) => setShopSession(id, s as USSDShopSession),
  cont: shopCont,
  end: shopEnd,
  async leave(ctx, s) {
    const next: USSDShopSession = { ...withoutBotFields(s as USSDShopSession), step: "SELECT_PRODUCT" }
    await setShopSession(ctx.sessionId, next)
    // No digit matches "": handleSelectProduct renders the product menu itself.
    const { handleSelectProduct } = await import("@/lib/ussd-shop/handlers/shop")
    return handleSelectProduct("", ctx.sessionId, next)
  },
}

/**
 * The Uzo menus' own session store + screens. The WhatsApp bots have no live io here: their router / adapter injects
 * one (deps.io), so a WhatsApp flow can never write the 120 s USSD session by accident.
 */
export function liveUzoBotIo(surface: BotFlowSurface): UzoBotIo {
  if (isWhatsappSurface(surface)) throw new Error("WhatsApp bot flows need an injected io")
  return surface === "ussd_shop" ? shopIo : mainIo
}

/**
 * Engine context for this buyer: main bots => no shop; shop bots => the session's resolved shop, and null (fail
 * closed) when the shop is missing or the profile does not match the surface. Rail paystack everywhere; the buyer is
 * always the session's number (dialler / WhatsApp sender).
 */
export function botFlowContext(ctx: BotFlowCtx): BotContext | null {
  if (!flowProfile(ctx)) return null
  if (isShopSurface(ctx.surface)) {
    if (!ctx.shopId) return null
    return { botSurface: ctx.surface, shopId: ctx.shopId, rail: "paystack", buyerPhone: ctx.dialingPhone }
  }
  return { botSurface: ctx.surface, shopId: null, rail: "paystack", buyerPhone: ctx.dialingPhone }
}

/** Plan 3 name. */
export const uzoBotContext = botFlowContext

/**
 * Shop screens start with the shop name. Uzo: printable ASCII, kept short so the screen footer always fits.
 * WhatsApp shop: the name as stored (whitespace collapsed), at most 60 chars.
 */
export function uzoShopHeader(ctx: BotFlowCtx): string {
  if (ctx.surface === "whatsapp_shop") {
    const wa = String(ctx.shopName ?? "").replace(/\s+/g, " ").trim().slice(0, 60).trim()
    return wa ? `${wa}\n` : ""
  }
  if (ctx.surface !== "ussd_shop") return ""
  const name = shopHeaderName(ctx.shopName ?? "").slice(0, 24).trim()
  return name ? `${name}\n` : ""
}

/** Printable ASCII only (UCS-2 would halve the screen) on names that come from Hubtel. */
export const ascii = (s: string): string => shopHeaderName(s)

/** "MoMo prompt sent" end text (also for an idempotent replay of the same prompt). */
export function uzoPromptSentText(dialingPhone: string): string {
  const local = normalizeGhanaPhone(dialingPhone) ?? dialingPhone
  return `MoMo prompt sent to ${local}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`
}

/**
 * WhatsApp "MoMo prompt sent" text. `promptedPhone` = the number the prompt actually went to (on a replay the
 * ORIGINAL prompt's number, which may differ from the number just typed); null => no number is named.
 */
export function waPromptSentText(promptedPhone: string | null): string {
  const local = promptedPhone ? normalizeGhanaPhone(promptedPhone) ?? promptedPhone : null
  const head = local ? `MoMo prompt sent to ${local}.` : "MoMo prompt sent."
  return `${head} Approve it on your phone to complete.\n\nReceived an OTP instead? Reply here with the code.`
}

export const UZO_BOT_UNAVAILABLE = botErrorText(503)

/** The engine refused an expired verify / catalog token at confirm: the buyer has to start over. */
export const UZO_BOT_RESTART = "Time limit exceeded. Please dial again to start over."
export const WA_BOT_RESTART = "Time limit exceeded. Please start over."
export const botRestartText = (p: BotFlowProfile): string => (p.kind === "whatsapp" ? WA_BOT_RESTART : UZO_BOT_RESTART)

/**
 * The session a flow leaves behind once its confirm has called the engine: every bot field (tokens included) is
 * dropped and the step is the menu's own (main: MAIN, shop: SELECT_PRODUCT, shop fields kept). Any later input on
 * this session lands on the menu, so back-navigation can never reach a confirm and create a second order.
 */
export function uzoBotClosedSession(ctx: BotFlowCtx, s: UzoBotSession): UzoBotSession {
  const out = withoutBotFields(s)
  return (isShopSurface(ctx.surface)
    ? { ...out, step: "SELECT_PRODUCT" }
    : { ...out, step: "MAIN" }) as UzoBotSession
}

/**
 * End the flow. WhatsApp sessions outlive the reply (Redis TTL), so the closed session (back to the menu, no flow
 * fields, no token) is saved first: a later "1" can never reach a confirm the buyer cancelled or that errored.
 * Uzo: `end` kills the USSD session, so nothing is saved (Plan 3 behaviour, pinned by the goldens).
 */
export async function endBotFlow(io: UzoBotIo, ctx: BotFlowCtx, s: UzoBotSession, text: string): Promise<UzoResponse> {
  if (isWhatsappSurface(ctx.surface)) await io.save(ctx.sessionId, uzoBotClosedSession(ctx, s))
  return io.end(text)
}

// ── WhatsApp: the typed MoMo number ──────────────────────────────────────────

export const PAY_PHONE_PROMPT = "Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Back"
export const PAY_PHONE_INVALID = "Invalid number."

/** A typed MoMo number in local 0XXXXXXXXX form, or null (the shared Ghana mobile validator). */
export function parsePayPhone(input: string): string | null {
  const local = normalizeGhanaPhone(String(input ?? "").replace(/[\s-]+/g, ""))
  return local && isValidGhanaMobile(local) ? local : null
}

/** The SMS code shape payer-verify issues (6 digits); anything else never reaches verifyPayerOtp. */
const PAY_VERIFY_CODE = /^\d{6}$/

export const PAY_VERIFY_TEXT = {
  wrongCode: "Wrong code. Try again.",
  notACode: "Please reply with the 6-digit code.",
  expired: "Code expired or too many tries. Please start over.",
  cancelled: "Order cancelled.",
} as const

export const payVerifyPrompt = (payPhone: string): string =>
  `We sent a 6-digit code by SMS to ${payPhone}.\nReply with the code to verify this MoMo number.\n\n0. Cancel`

/** Two GHS amounts equal to the pesewa (the engine order's price vs the price the confirm screen showed). */
export const samePrice = (a: number, b: number): boolean =>
  Number.isFinite(a) && Number.isFinite(b) && Math.round(a * 100) === Math.round(b * 100)

/** What the read-back + charge tail needs. */
export interface UzoBotPayDeps {
  /** The order's status + payment_status; null when there is no row. Throws on a read error. */
  readOrder(orderId: string): Promise<{ status?: string | null; payment_status?: string | null } | null>
  /** Guarded fail (only a still pending + unpaid channel 'bots' row is touched). Never throws. */
  failOrder(orderId: string): Promise<void>
  charge(input: BotChargeInput): Promise<BotChargeResult>
  /**
   * WhatsApp only: the SMS check of the typed paying number (lib/bot-commission/payer-verify.ts). Absent on the Uzo
   * menus; a WhatsApp flow without it fails closed at NEEDS_VERIFY.
   */
  payer?: {
    send(phone: string, requester: string): Promise<SendPayerOtpResult>
    verify(phone: string, code: string): Promise<VerifyPayerOtpResult>
  }
}

/** Generic name of the pay deps (Plan 3 name kept). */
export type BotFlowPayDeps = UzoBotPayDeps

/** How a charge attempt ended: an end text, or (WhatsApp) the paying number needs its SMS check first. */
export type BotChargeOutcome = { kind: "end"; text: string } | { kind: "verify" }

/**
 * After the engine created (or handed back) an order: charge it only while it is still pending + unpaid, by a MoMo
 * prompt to the paying number (Uzo: the dialling number; WhatsApp: `payPhone`, the number the buyer typed).
 * - Read error / no row: its state is unknown, so it is failed (guarded) and nothing is charged.
 * - Not open (paid / closed): refused, nothing charged; the guarded patch could not touch it anyway.
 * - Charge refusals carry their own buyer text (NO_PROVIDER / RATE_LIMITED already failed the order; CHARGE_FAILED
 *   may leave it open and it is not touched here). A charge call that throws fails the order (guarded).
 * - WhatsApp: no payPhone => failed (guarded), nothing charged; NEEDS_VERIFY (nothing written, order left open) =>
 *   `{ kind: "verify" }`, the flow runs the SMS check and calls this again for the same order.
 */
export async function botFlowChargeOrder(
  d: UzoBotPayDeps, ctx: BotFlowCtx, orderType: BotChargeInput["orderType"], orderId: string, logTag: string,
  payPhone?: string,
): Promise<BotChargeOutcome> {
  const end = (text: string): BotChargeOutcome => ({ kind: "end", text })
  const wa = isWhatsappSurface(ctx.surface)
  if (wa && !payPhone) {
    console.error(`[${logTag}] no paying number; refusing to charge:`, orderId)
    await d.failOrder(orderId)
    return end(UZO_BOT_UNAVAILABLE)
  }
  let row: { status?: string | null; payment_status?: string | null } | null
  try {
    row = await d.readOrder(orderId)
  } catch (e) {
    console.error(`[${logTag}] order read-back failed:`, orderId, e instanceof Error ? e.message : "error")
    await d.failOrder(orderId)
    return end(UZO_BOT_UNAVAILABLE)
  }
  if (!row) {
    console.error(`[${logTag}] order not found on read-back:`, orderId)
    await d.failOrder(orderId)
    return end(UZO_BOT_UNAVAILABLE)
  }
  if (row.status !== "pending" || row.payment_status !== "unpaid") {
    console.error(`[${logTag}] order is not open; refusing to charge:`, orderId, row.status ?? null, row.payment_status ?? null)
    return end(UZO_BOT_UNAVAILABLE)
  }
  // Uzo: exactly the Plan 3 input (no payPhone key: the engine charges the dialler).
  const input: BotChargeInput = {
    orderType, orderId, botSurface: ctx.surface, shopId: isShopSurface(ctx.surface) ? ctx.shopId : null, dialingPhone: ctx.dialingPhone,
  }
  if (wa) input.payPhone = payPhone
  let r: BotChargeResult
  try {
    r = await d.charge(input)
  } catch (e) {
    console.error(`[${logTag}] charge threw:`, orderId, e instanceof Error ? e.message : "error")
    await d.failOrder(orderId)
    return end(UZO_BOT_UNAVAILABLE)
  }
  if (!r.ok) return wa && r.code === "NEEDS_VERIFY" ? { kind: "verify" } : end(r.message)
  return end(wa ? waPromptSentText(r.promptedPhone) : uzoPromptSentText(ctx.dialingPhone))
}

/** Plan 3 tail (Uzo menus): the end text of botFlowChargeOrder. */
export async function uzoChargeOrder(
  d: UzoBotPayDeps, ctx: UzoBotCtx, orderType: BotChargeInput["orderType"], orderId: string, logTag: string,
): Promise<string> {
  const r = await botFlowChargeOrder(d, ctx, orderType, orderId, logTag)
  return r.kind === "end" ? r.text : UZO_BOT_UNAVAILABLE
}

/**
 * NEEDS_VERIFY: SMS a code to the paying number (requester = the WhatsApp sender). `ok` => ask for the code; else the
 * order is failed (guarded: nobody can pay it any more) and the text ends the flow.
 */
export async function startPayerVerify(
  d: UzoBotPayDeps, ctx: BotFlowCtx, orderId: string, payPhone: string, logTag: string,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  let sent: SendPayerOtpResult = { ok: false, code: "SEND_FAILED" }
  if (d.payer) {
    try {
      sent = await d.payer.send(payPhone, ctx.dialingPhone)
    } catch (e) {
      console.error(`[${logTag}] payer code send threw:`, e instanceof Error ? e.message : "error")
    }
  } else {
    console.error(`[${logTag}] no payer verification wired; refusing:`, orderId)
  }
  if (sent.ok) return { ok: true, text: payVerifyPrompt(payPhone) }
  await d.failOrder(orderId)
  return { ok: false, text: sent.code === "RATE_LIMITED" ? botErrorText(429) : UZO_BOT_UNAVAILABLE }
}

/**
 * The code the buyer typed at *_PAY_VERIFY. "0" cancels; a wrong code with a live code waiting => retry; verified =>
 * the SAME order is charged again (botChargeMomo re-checks it and replays a live prompt). Anything that ends the flow
 * without a prompt fails the order (guarded).
 */
export async function payerVerifyStep(
  d: UzoBotPayDeps, ctx: BotFlowCtx, input: string, orderType: BotChargeInput["orderType"], orderId: string,
  payPhone: string, logTag: string,
): Promise<{ kind: "retry"; text: string } | { kind: "end"; text: string }> {
  if (input === "0") {
    await d.failOrder(orderId)
    return { kind: "end", text: PAY_VERIFY_TEXT.cancelled }
  }
  // Free text ("hi", "menu", a wrong length) is not a code: re-prompt without spending a verify attempt.
  if (!PAY_VERIFY_CODE.test(input)) return { kind: "retry", text: `${PAY_VERIFY_TEXT.notACode}\n${payVerifyPrompt(payPhone)}` }
  let v: VerifyPayerOtpResult = { ok: false, retry: false }
  if (d.payer) {
    try {
      v = await d.payer.verify(payPhone, input)
    } catch (e) {
      // Fail closed: never an open-ended re-prompt while the check is down; the order stops holding the caps.
      console.error(`[${logTag}] payer code check threw:`, e instanceof Error ? e.message : "error")
      await d.failOrder(orderId)
      return { kind: "end", text: UZO_BOT_UNAVAILABLE }
    }
  }
  if (!v.ok) {
    if (v.retry) return { kind: "retry", text: `${PAY_VERIFY_TEXT.wrongCode}\n${payVerifyPrompt(payPhone)}` }
    await d.failOrder(orderId)
    return { kind: "end", text: PAY_VERIFY_TEXT.expired }
  }
  const r = await botFlowChargeOrder(d, ctx, orderType, orderId, logTag, payPhone)
  if (r.kind === "end") return r
  // Still NEEDS_VERIFY right after a verified code (e.g. the lookup failed): fail closed, never loop.
  console.error(`[${logTag}] still not payable after verification:`, orderId)
  await d.failOrder(orderId)
  return { kind: "end", text: UZO_BOT_UNAVAILABLE }
}
