// Missed-call SMS copy. Plain ASCII (GSM-7), exactly one segment each; sendReply refuses anything else.

import { calculateSegments } from "@/lib/sms/segments"
import { shopNameText } from "../replies"

const oneSegment = (text: string): boolean => {
  const r = calculateSegments(text)
  return r.encoding === "gsm7" && r.segments === 1
}

/** Main line, and the shop line's fallback: Datagod's WhatsApp support. waDigits is digits only (see support.ts). */
export function callSupportReply(waDigits: string): string {
  return `Sorry we missed your call. For help WhatsApp us: https://wa.me/${waDigits}`
}

/** Shop line, caller linked to a shop: the shop's name and the owner's number. The name shrinks until one segment fits. */
export function callShopReply(shopName: string, ownerNumber: string): string {
  const build = (name: string) => `Sorry we missed your call. Please contact ${name} on ${ownerNumber}.`
  for (let max = 40; max >= 1; max -= 1) {
    const text = build(shopNameText(shopName, max))
    if (oneSegment(text)) return text
  }
  return build("Shop")
}
