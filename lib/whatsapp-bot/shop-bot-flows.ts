// Commission-cashback "Network Plans" + "Pay Bills" on the WhatsApp SHOP bot (lib/whatsapp-bot/shop-router.ts).
// The shared flows (lib/ussd/bots/network-plans.ts, pay-bills.ts) run with WHATSAPP_PROFILE, surface "whatsapp_shop",
// shopId = the shop the session resolved from the shop code (never its parent) and the sender (local 0X form) as the
// buyer. This module is the thin adapter between them and the shop bot:
// - Session: WaShopSession already carries the flows' fields (np* / pb*, step, dataBlocked), so it maps to the flow
//   session as is and back with `botOtp` dropped; a closed flow lands on SELECT_PRODUCT, the shop bot's own product
//   step, with the shop fields kept. Stored in the shop bot's own session store (shop-session.ts, 30-min TTL).
// - Screens: WhatsApp text (no USSD cut); the typed-MoMo-number screens use the shop bot's own payment-phone wording
//   (shopPaymentPhonePrompt / shopInvalidPaymentPhoneMenu), and "0" there cancels, as on every shop product.
// - "Back to menu" = the shop's product menu (same visibility rules as its dispatch).
// - Order safety: the shop is re-checked (isShopStillOpen) right before the order is created (confirm "1") and right
//   before a verified payer code would charge (*_PAY_VERIFY); a closed shop fails closed with the shop-closed text.
// - Paystack send_otp: same as the main bot (bot-flows.ts) but in the shop bot's OWN key space: a pointer this reply's
//   charge stored under the sender in wa-shop-bot-otp puts the chat on SUBMIT_OTP (botOtp); the next reply goes to
//   submitBotOtp. The main bot's wa-bot-otp pointer for the same sender is never read or cleared here.
import { createClient } from "@supabase/supabase-js"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import {
  endBotFlow, withoutBotFields, PAY_PHONE_INVALID, PAY_PHONE_PROMPT, type BotFlowCtx, type UzoBotIo, type UzoBotSession,
} from "@/lib/ussd/bots/kit"
import { handleNetworkPlansStep, liveNetworkPlansDeps, startNetworkPlans } from "@/lib/ussd/bots/network-plans"
import { handlePayBillsStep, livePayBillsDeps, startPayBills } from "@/lib/ussd/bots/pay-bills"
import { WHATSAPP_PROFILE } from "@/lib/ussd/bots/profile"
import { botErrorText } from "@/lib/ussd/bots/screen"
import type { USSDSession, UzoResponse } from "@/lib/ussd/types"
import { handleWaBotOtp, waBotNaturalToDigit, waBotOtpPending } from "./bot-flows"
import { whatsappBotItemsVisible } from "./cashback-visibility"
import { shopInvalidPaymentPhoneMenu, shopPaymentPhonePrompt, shopProductMenu, type ShopBotMenuItems } from "./shop-menus"
import { setSession } from "./shop-session"
import type { WaShopSession } from "./shop-types"

export { isWaBotStep as isShopBotStep } from "./bot-flows"

/** The reply on the shop bot's OTP step: the sender's pointer in the SHOP key space (`wa-shop-bot-otp`) only. */
export function handleShopBotOtp(sender: string, input: string): Promise<UzoResponse> {
  return handleWaBotOtp(sender, input, "whatsapp_shop")
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const TAG = "WA-SHOP-BOTS"

// ── Session adapter ──────────────────────────────────────────────────────────

/** The shop session as the flows see it: it already holds their fields (step, dataBlocked, np* / pb*). */
export function toFlowSession(s: WaShopSession): UzoBotSession {
  return { ...s } as unknown as UzoBotSession
}

/**
 * A flow session back to the shop session. The flows' closed step SELECT_PRODUCT is the shop bot's own product step;
 * `botOtp` is never carried (only the send_otp hand-off below sets it).
 */
export function fromFlowSession(s: UzoBotSession): WaShopSession {
  const out = { ...(s as unknown as WaShopSession) }
  delete out.botOtp
  return out
}

/** The shop session without any flow field (what the product menu had before the flow started). */
const withoutFlow = (s: WaShopSession): WaShopSession => fromFlowSession(withoutBotFields(toFlowSession(s)))

/**
 * The flows' engine context on the shop bot; null (fail closed) for a sender that is not a Ghana number or a session
 * without a resolved shop.
 */
export function waShopBotCtx(sender: string, s: WaShopSession): BotFlowCtx | null {
  const local = normalizeGhanaPhone(String(sender ?? ""))
  if (!local || !s.shopId || !s.shopCodeId) return null
  return {
    surface: "whatsapp_shop", sessionId: sender, dialingPhone: local, shopId: s.shopId, shopName: s.shopName, profile: WHATSAPP_PROFILE,
  }
}

// ── Product menu ─────────────────────────────────────────────────────────────

/**
 * Which cashback items the product menu shows: WhatsApp switches AND the cashback gate (fail closed); Network Plans
 * also follows the data whitelist exactly like Data Bundle (hidden while `dataBlocked`). Pay Bills does not.
 */
export async function shopBotMenuItems(session: Pick<WaShopSession, "dataBlocked">): Promise<ShopBotMenuItems> {
  const v = await whatsappBotItemsVisible(supabase)
  return { networkPlans: v.networkPlans === true && session.dataBlocked !== true, payBills: v.payBills === true }
}

/** The shop's product menu for this session (switches off => today's shopProductMenu text, byte for byte). */
export async function shopProductMenuFor(shopName: string, session: Pick<WaShopSession, "dataBlocked">): Promise<string> {
  return shopProductMenu(shopName, session.dataBlocked !== true, await shopBotMenuItems(session))
}

// ── io ───────────────────────────────────────────────────────────────────────

/** The flows' typed-MoMo-number screens in the shop bot's own wording; every other text as the flow wrote it. */
export function shopFlowText(message: string): string {
  if (!message.endsWith(PAY_PHONE_PROMPT)) return message
  const prefix = message.slice(0, message.length - PAY_PHONE_PROMPT.length)
  if (prefix === `${PAY_PHONE_INVALID}\n`) return shopInvalidPaymentPhoneMenu()
  return prefix + shopPaymentPhonePrompt()
}

/** Shop-bot io: the shop session store; WhatsApp text; "back" = the shop's product menu. */
export const waShopBotIo: UzoBotIo = {
  save: (id, s) => setSession(id, fromFlowSession(s)),
  cont: (message) => ({ message: shopFlowText(message), ussdServiceOp: 2 }),
  end: (message) => ({ message: shopFlowText(message), ussdServiceOp: 17 }),
  async leave(ctx, s) {
    const next: WaShopSession = { ...withoutFlow(fromFlowSession(s)), step: "SELECT_PRODUCT" }
    await setSession(ctx.sessionId, next)
    return { message: await shopProductMenuFor(next.shopName ?? "Shop", next), ussdServiceOp: 2 }
  },
}

// ── Flows ────────────────────────────────────────────────────────────────────

export interface ShopBotHooks {
  /** The shop router's CONFIRM-time shop status re-check (active + WhatsApp activated). */
  isShopStillOpen(shopCodeId: string): Promise<boolean>
  /** The shop bot's existing shop-closed reply. */
  closedText: string
}

const isPayPhoneStep = (step: string) => step === "NP_PAY_PHONE" || step === "PB_PAY_PHONE"
const isConfirmStep = (step: string) => step === "NP_CONFIRM" || step === "PB_CONFIRM"
const isPayVerifyStep = (step: string) => step === "NP_PAY_VERIFY" || step === "PB_PAY_VERIFY"

/** Re-check the session's shop (fail closed: no code id / a lookup error = closed). */
async function shopOpen(session: WaShopSession, hooks: ShopBotHooks): Promise<boolean> {
  if (!session.shopCodeId) return false
  try {
    return await hooks.isShopStillOpen(session.shopCodeId)
  } catch (e) {
    console.error(`[${TAG}] shop re-check failed; refusing:`, e instanceof Error ? e.message : "error")
    return false
  }
}

/**
 * Tail of a flow reply: a final screen whose charge answered Paystack `send_otp` during THIS reply (the sender's
 * wa-shop-bot-otp pointer is newer than `since`) puts the chat on SUBMIT_OTP for the code. Everything else was already
 * saved by the flow (the closed session lands on SELECT_PRODUCT).
 */
async function finish(sender: string, session: WaShopSession, r: UzoResponse, since: number): Promise<string> {
  if (r.ussdServiceOp === 17 && (await waBotOtpPending(sender, since, "whatsapp_shop"))) {
    await setSession(sender, { ...withoutFlow(session), step: "SUBMIT_OTP", botOtp: true })
  }
  return r.message
}

const npDeps = () => liveNetworkPlansDeps("whatsapp_shop", waShopBotIo)
const pbDeps = () => livePayBillsDeps("whatsapp_shop", waShopBotIo)

/**
 * Start a flow from the product menu (only reachable when shopBotMenuItems showed its item; the caller re-checked the
 * data whitelist for Network Plans). Never charges. Returns the reply; the session is stored by the flow.
 */
export async function startShopBotFlow(kind: "networkPlans" | "payBills", sender: string, session: WaShopSession): Promise<string> {
  const ctx = waShopBotCtx(sender, session)
  if (!ctx) return botErrorText(403)
  const r = kind === "networkPlans"
    ? await startNetworkPlans(ctx, toFlowSession(session), npDeps())
    : await startPayBills(ctx, toFlowSession(session), pbDeps())
  return r.message
}

/**
 * One reply on an NP_* / PB_* step. Free text is mapped to a digit only where obvious (never at the MoMo number, the
 * SMS code or typed data). Returns the reply; every session write is done here or by the flow.
 */
export async function handleShopBotStep(sender: string, input: string, session: WaShopSession, hooks: ShopBotHooks): Promise<string> {
  const since = Date.now()
  const flow = toFlowSession(session)
  const ctx = waShopBotCtx(sender, session)
  if (!ctx) {
    const dead: BotFlowCtx = { surface: "whatsapp_shop", sessionId: sender, dialingPhone: "", shopId: null }
    return (await endBotFlow(waShopBotIo, dead, flow, botErrorText(403))).message
  }
  let text = String(input ?? "").trim()
  if (!/^\d+$/.test(text)) text = waBotNaturalToDigit(session.step, text, flow as USSDSession) ?? text

  // Shop wording: "0. Cancel" on the MoMo number screen cancels (the flow itself would step back).
  if (isPayPhoneStep(session.step) && text === "0") {
    return (await endBotFlow(waShopBotIo, ctx, flow, "Order cancelled.")).message
  }

  // The shop may have closed since its code was entered (30-min session): re-check right before the order is created
  // and right before a verified payer code would charge it.
  const ordering = isConfirmStep(session.step) && text === "1"
  const verifying = isPayVerifyStep(session.step) && /^\d{6}$/.test(text)
  if ((ordering || verifying) && !(await shopOpen(session, hooks))) {
    if (verifying) {
      // The flow's own cancel: the open order is failed (guarded) and the flow closed; nothing is charged.
      if (session.step === "NP_PAY_VERIFY") await handleNetworkPlansStep(ctx, "0", flow, npDeps())
      else await handlePayBillsStep(ctx, "0", flow, pbDeps())
    } else {
      await endBotFlow(waShopBotIo, ctx, flow, hooks.closedText)
    }
    return hooks.closedText
  }

  const r = session.step.startsWith("NP_")
    ? await handleNetworkPlansStep(ctx, text, flow, npDeps())
    : await handlePayBillsStep(ctx, text, flow, pbDeps())
  return finish(sender, session, r, since)
}
