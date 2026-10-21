// Finishing a commission-cashback bot MoMo charge that Paystack answered with `send_otp`, on redial of the Uzo main or
// shop USSD. The charge left a Redis pointer keyed by the dialing phone (lib/bot-commission/otp-pointer.ts); on op=1
// the routers add it as one more pending-OTP candidate (newest created_at wins), and when it wins the next input is
// handled here. The pointer is always looked up again by the network-authenticated MSISDN (that lookup is the auth);
// nothing about it is kept in the USSD session except the `botOtp` flag.
import { getBotMomoRuntime } from "@/lib/bot-commission/momo"
import { failBotCharge } from "@/lib/bot-commission/momo-fail"
import {
  clearBotOtpPointer, peekBotOtpPointer, submitBotOtp, type BotOtpChannel, type StoredBotOtpPointer, type SubmitBotOtpResult,
} from "@/lib/bot-commission/otp-pointer"
import type { UzoResponse } from "../types"

const TAG = "USSD-BOT-OTP"

export const BOT_OTP_TEXT = {
  /** Byte-identical to the existing OTP prompt on both menus (lib/ussd/router.ts, lib/ussd-shop/menus.ts otpMenu). */
  prompt: "Pending payment.\nEnter the OTP sent\nto your number to\ncomplete payment:\n\n0. Cancel",
  /** Same text the existing OTP handlers end with once the code is in. */
  approve: "Check your phone for\na MoMo authorization\nprompt and approve\nto complete payment.",
  wrong: "Wrong code. Try again.",
  failed: "Payment failed. Please try again.",
  expired: "Payment session expired. Please start again.",
  cancelled: "Order cancelled.",
} as const

export interface BotOtpRedialDeps {
  peek(phone: string): Promise<StoredBotOtpPointer | null>
  submit(p: StoredBotOtpPointer, otp: string): Promise<SubmitBotOtpResult>
  /** Buyer cancelled: guarded fail of the payment row + order (a paid order is never touched), pointer cleared. */
  cancel(p: StoredBotOtpPointer): Promise<void>
}

/**
 * Live wiring. `channel` = the pointer key space: "ussd" (default, the Uzo menus: exactly as before) or "whatsapp"
 * (the WhatsApp bots, `wa-bot-otp:<sender>`): the peek and the cancel's clear stay inside that key space.
 */
export function liveBotOtpRedialDeps(channel: BotOtpChannel = "ussd"): BotOtpRedialDeps {
  return {
    peek: channel === "whatsapp" ? (phone) => peekBotOtpPointer(phone, "whatsapp") : peekBotOtpPointer,
    submit: (p, otp) => submitBotOtp(getBotMomoRuntime(), p, otp),
    async cancel(p) {
      await failBotCharge(getBotMomoRuntime().db, p.orderType, p.orderId, p.reference, TAG)
      if (channel === "whatsapp") await clearBotOtpPointer(p.phone, "whatsapp")
      else await clearBotOtpPointer(p.phone)
    },
  }
}

/** The pointer as a pending-OTP candidate ({ created_at }), or null. Never throws (a read error = no candidate). */
export async function botOtpCandidate(
  dialingPhone: string, peek: BotOtpRedialDeps["peek"] = peekBotOtpPointer,
): Promise<{ created_at: string } | null> {
  try {
    const p = await peek(dialingPhone)
    return p ? { created_at: p.createdAt } : null
  } catch (e) {
    console.error(`[${TAG}] pointer read failed:`, e instanceof Error ? e.message : "error")
    return null
  }
}

const cont = (message: string): UzoResponse => ({ message, ussdServiceOp: 2 })
const end = (message: string): UzoResponse => ({ message, ussdServiceOp: 17 })

/**
 * The input on the bot OTP prompt. `0` cancels; a code goes to submitBotOtp:
 * - ok => the approve-prompt text (end);
 * - retry (wrong code / not final / submit call failed) => "Wrong code. Try again." + the prompt (the caller keeps the
 *   session on the OTP step);
 * - final failure (payment + order already failed by submitBotOtp) => the payment-failed text (end).
 */
export async function handleBotOtpRedial(
  input: string, dialingPhone: string, d: BotOtpRedialDeps = liveBotOtpRedialDeps(),
): Promise<UzoResponse> {
  let p: StoredBotOtpPointer | null
  try {
    p = await d.peek(dialingPhone)
  } catch (e) {
    console.error(`[${TAG}] pointer read failed:`, e instanceof Error ? e.message : "error")
    p = null
  }
  if (!p) return end(BOT_OTP_TEXT.expired)

  const code = (input ?? "").trim()
  if (code === "0") {
    try {
      await d.cancel(p)
    } catch (e) {
      console.error(`[${TAG}] cancel failed:`, e instanceof Error ? e.message : "error")
    }
    return end(BOT_OTP_TEXT.cancelled)
  }
  if (!/^\d{3,10}$/.test(code)) return cont(`${BOT_OTP_TEXT.wrong}\n${BOT_OTP_TEXT.prompt}`)

  let r: SubmitBotOtpResult
  try {
    r = await d.submit(p, code)
  } catch (e) {
    console.error(`[${TAG}] submit failed:`, e instanceof Error ? e.message : "error")
    r = { ok: false, retry: true }
  }
  if (r.ok) return end(BOT_OTP_TEXT.approve)
  if (r.retry) return cont(`${BOT_OTP_TEXT.wrong}\n${BOT_OTP_TEXT.prompt}`)
  return end(BOT_OTP_TEXT.failed)
}
