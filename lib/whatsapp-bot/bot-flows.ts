// Commission-cashback "Network Plans" + "Pay Bills" on the MAIN WhatsApp bot (lib/whatsapp-bot/router.ts).
// The shared flows (lib/ussd/bots/network-plans.ts, pay-bills.ts) run with WHATSAPP_PROFILE, surface "whatsapp",
// shopId null and the sender (local 0X form) as the buyer. WhatsApp has no default io in the kit: this module injects
// one backed by the WhatsApp session store (30-min TTL), with uncut WhatsApp messages and "back to menu" = the
// WhatsApp main menu (handleMain, channel "whatsapp").
// It also finishes a Paystack `send_otp` bot charge in chat: the charge stored a pointer under the sender in the
// `wa-bot-otp` key space; the router puts the chat on SUBMIT_OTP (botOtp) and the next reply goes to submitBotOtp.
import { peekBotOtpPointer } from "@/lib/bot-commission/otp-pointer"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { handleMain } from "@/lib/ussd/handlers/main"
import { endBotFlow, type BotFlowCtx, type UzoBotIo, type UzoBotSession } from "@/lib/ussd/bots/kit"
import { handleNetworkPlansStep, liveNetworkPlansDeps, startNetworkPlans } from "@/lib/ussd/bots/network-plans"
import { handleBotOtpRedial, liveBotOtpRedialDeps } from "@/lib/ussd/bots/otp-redial"
import { handlePayBillsStep, livePayBillsDeps, startPayBills } from "@/lib/ussd/bots/pay-bills"
import { WHATSAPP_PROFILE } from "@/lib/ussd/bots/profile"
import { botErrorText } from "@/lib/ussd/bots/screen"
import type { USSDSession, UzoResponse } from "@/lib/ussd/types"
import { setWaSession } from "./session"

const TAG = "WA-BOTS"

/** The flows' engine context on the main WhatsApp bot; null for a sender that is not a Ghana number (fail closed). */
export function waBotCtx(sender: string): BotFlowCtx | null {
  const local = normalizeGhanaPhone(String(sender ?? ""))
  if (!local) return null
  return { surface: "whatsapp", sessionId: sender, dialingPhone: local, shopId: null, profile: WHATSAPP_PROFILE }
}

/** WhatsApp io: the bot's own session store; messages are never cut to a USSD screen. */
export const waBotIo: UzoBotIo = {
  save: (id, s) => setWaSession(id, s as USSDSession),
  cont: (message) => ({ message, ussdServiceOp: 2 }),
  end: (message) => ({ message, ussdServiceOp: 17 }),
  async leave(ctx, s) {
    const next: USSDSession = { step: "MAIN", dialingPhone: ctx.dialingPhone, dataBlocked: (s as USSDSession).dataBlocked }
    await setWaSession(ctx.sessionId, next)
    // No digit matches "": handleMain renders the WhatsApp main menu itself (same visibility rules as its dispatch).
    return handleMain("", ctx.sessionId, next, "whatsapp")
  },
}

/** Steps owned by the bot flows (Network Plans NP_*, Pay Bills PB_*, the WhatsApp-only ones included). */
export function isWaBotStep(step: string | undefined): boolean {
  return typeof step === "string" && (step.startsWith("NP_") || step.startsWith("PB_"))
}

const notAvailable = (): UzoResponse => waBotIo.end(botErrorText(403))

/** Start a flow from the main menu (only reachable when whatsappBotItemsVisible showed its item). */
export async function startWaBotFlow(
  kind: "networkPlans" | "payBills", sender: string, session: USSDSession,
): Promise<UzoResponse> {
  const ctx = waBotCtx(sender)
  if (!ctx) return notAvailable()
  return kind === "networkPlans"
    ? startNetworkPlans(ctx, session, liveNetworkPlansDeps("whatsapp", waBotIo))
    : startPayBills(ctx, session, livePayBillsDeps("whatsapp", waBotIo))
}

/** One reply on an NP_* / PB_* step. */
export async function handleWaBotStep(sender: string, input: string, session: USSDSession): Promise<UzoResponse> {
  const ctx = waBotCtx(sender)
  if (!ctx) return endBotFlow(waBotIo, { surface: "whatsapp", sessionId: sender, dialingPhone: "", shopId: null }, session as UzoBotSession, botErrorText(403))
  if (session.step.startsWith("NP_")) return handleNetworkPlansStep(ctx, input, session, liveNetworkPlansDeps("whatsapp", waBotIo))
  return handlePayBillsStep(ctx, input, session, livePayBillsDeps("whatsapp", waBotIo))
}

/** The WhatsApp bots' pointer key spaces: the main bot ("whatsapp") and the shop bot ("whatsapp_shop"). */
export type WaBotOtpChannel = "whatsapp" | "whatsapp_shop"

/**
 * A Paystack `send_otp` pointer this sender's charge stored during THIS reply (created at or after `since`, epoch ms),
 * in this bot's key space (default: the main bot's). An older pointer (an earlier order) never takes over the chat.
 * Never throws.
 */
export async function waBotOtpPending(sender: string, since: number, channel: WaBotOtpChannel = "whatsapp"): Promise<boolean> {
  const local = normalizeGhanaPhone(String(sender ?? ""))
  if (!local) return false
  try {
    const p = await peekBotOtpPointer(local, channel)
    const at = p ? Date.parse(p.createdAt) : NaN
    return Number.isFinite(at) && at >= since
  } catch (e) {
    console.error(`[${TAG}] OTP pointer read failed:`, e instanceof Error ? e.message : "error")
    return false
  }
}

/**
 * The reply on the bot OTP step: the pointer is looked up again by the sender in this bot's key space (that lookup is
 * the auth). Default: the main bot.
 */
export async function handleWaBotOtp(sender: string, input: string, channel: WaBotOtpChannel = "whatsapp"): Promise<UzoResponse> {
  const local = normalizeGhanaPhone(String(sender ?? "")) ?? ""
  return handleBotOtpRedial(input, local, liveBotOtpRedialDeps(channel))
}

/**
 * Natural replies on the bot steps, only where the meaning is obvious (whole reply, case / spaces ignored):
 * "my number" on the recipient choice, "yes" / "no" / "cancel" on the confirm screens, "cancel" on the meter-link
 * consent (linking itself needs an explicit "1"). Never on a step that takes typed data: the MoMo number, the SMS code
 * (*_PAY_VERIFY), the account / meter / amount / email entries, or the typed recipient.
 */
export function waBotNaturalToDigit(step: string, input: string, session: USSDSession): string | null {
  const lc = String(input ?? "").toLowerCase().replace(/[\s.!]+/g, "")
  const mine = /^(my(own)?(number|phone|line)?|me|myself|mine|thisnumber)$/.test(lc)
  if (step === "NP_RECIPIENT" && !session.npOtherNumber) {
    if (mine) return "1"
    if (/^(other|another|othernumber|anothernumber|someoneelse)$/.test(lc)) return "2"
    return null
  }
  if (step === "PB_ECG_MODE") return mine ? "1" : null
  if (step === "NP_CONFIRM" || step === "PB_CONFIRM") {
    if (/^(yes|y|ok|okay|confirm|pay|paynow)$/.test(lc)) return "1"
    if (/^(no|n|cancel|stop)$/.test(lc)) return "2"
    return null
  }
  if (step === "PB_CONSENT") return /^(no|cancel|stop)$/.test(lc) ? "2" : null
  return null
}
