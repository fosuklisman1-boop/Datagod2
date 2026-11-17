/**
 * What a refused customer is told, by blocked-numbers mode.
 *   off       - the feature is off: every message is exactly today's text.
 *   saved     - enabled, customer SMS off: "saved, checked daily" (no SMS promise).
 *   saved_sms - enabled and customer SMS on: "saved, we'll SMS you when ready".
 * Dealer surfaces never promise an SMS to the end customer.
 * Builders are pure; getNoticeMode() never throws (any failure is "off").
 */

import { getBlockedNumbersSettings, type BlockedNumbersSettings } from "./settings"
import { NOT_VERIFIED_MESSAGE, RECIPIENT_BLOCKED_PROMPT } from "@/lib/mtn-providers/customer-verification"
import { RECIPIENT_BLOCKED_NOTE } from "@/lib/ussd-hubtel/confirm-note"
import { fitOneSegment } from "@/lib/text-to-buy/replies"

export type NoticeMode = "off" | "saved" | "saved_sms"

export function noticeModeFrom(s: BlockedNumbersSettings): NoticeMode {
  if (!s.enabled) return "off"
  return s.customer_sms_enabled ? "saved_sms" : "saved"
}

export async function getNoticeMode(): Promise<NoticeMode> {
  try {
    return noticeModeFrom(await getBlockedNumbersSettings())
  } catch {
    return "off"
  }
}

const NOT_READY = "This MTN number isn't ready for data yet, so it can't be ordered now."

export function webCustomerNotice(mode: NoticeMode): string {
  if (mode === "saved_sms") return `${NOT_READY} We've saved it and will send an SMS to that number when it's ready. You can use a different number now.`
  if (mode === "saved") return `${NOT_READY} We've saved it and check it every day. Please try again later or use a different number.`
  return NOT_VERIFIED_MESSAGE
}

export function dealerNotice(mode: NoticeMode): string {
  if (mode === "off") return NOT_VERIFIED_MESSAGE
  return `${NOT_READY} We've saved it to Blocked Numbers on your dashboard and will notify you when it's ready.`
}

export function botPrompt(mode: NoticeMode): string {
  if (mode === "saved_sms") return "MTN number not ready for data yet.\nSaved: we'll SMS you when ready.\nEnter a different number:\n\n0. Back"
  if (mode === "saved") return "MTN number not ready for data yet.\nSaved: try again later.\nEnter a different number:\n\n0. Back"
  return RECIPIENT_BLOCKED_PROMPT
}

export function hubtelNote(mode: NoticeMode): string {
  if (mode === "saved_sms") return "MTN number not ready for data yet. Saved: we'll SMS you when ready."
  if (mode === "saved") return "MTN number not ready for data yet. Saved: try again later."
  return RECIPIENT_BLOCKED_NOTE
}

export function ttbNotice(mode: NoticeMode): string {
  const head = "That MTN number is not ready for data yet."
  if (mode === "saved_sms") return fitOneSegment([head, "We saved it and will text you when it's ready."])
  if (mode === "saved") return fitOneSegment([head, "We saved it. Try again later."])
  return fitOneSegment([head, "Try a different number."])
}

export function aiToolNotice(mode: NoticeMode): string {
  const base = `${NOT_VERIFIED_MESSAGE} Ask the customer for a different recipient number.`
  if (mode === "saved_sms") return `${base} Tell the customer we've saved the number and will text them when it's ready.`
  if (mode === "saved") return `${base} Tell the customer we've saved the number and they can try again later.`
  return base
}
