// Text-to-Buy: every SMS the lane can send, as pure functions.
// All copy is plain ASCII (GSM-7) and every reply goes through fitOneSegment, so
// one reply is always exactly one 160-character segment. Money figures are filled
// by code from the value written to the order; the AI never supplies them.

import { calculateSegments } from "@/lib/sms/segments"

export const MAX_REPLY_CHARS = 160

export type QuoteInput = {
  size: string // package size as stored, e.g. "5GB"
  networkLabel: string // "MTN" | "Telecel" | "AT"
  recipientLocal: string
  amountGhs: number // the value written to the order
  feeOnTop: boolean // gateway adds its own charge for the customer
  payerNetwork: "MTN" | "TELECEL" | "AT" | "UNKNOWN"
}

type SizePrice = { size: string; priceGhs: number }

function fitsOneSegment(text: string): boolean {
  const r = calculateSegments(text)
  return r.encoding === "gsm7" && r.segments === 1
}

/** Joins parts with a space, dropping parts from the END until one GSM-7 segment fits. */
export function fitOneSegment(parts: string[]): string {
  const kept = parts.filter((p) => p.length > 0)
  while (kept.length > 0) {
    const text = kept.join(" ")
    if (fitsOneSegment(text)) return text
    kept.pop()
  }
  // Even the first part alone is too long: hard cap so it can never bill two segments.
  return parts.join(" ").slice(0, MAX_REPLY_CHARS)
}

export function formatGhs(n: number): string {
  return `GHS ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const PAYER_TIPS: Record<QuoteInput["payerNetwork"], string> = {
  MTN: "No prompt? Dial *170#, 6, 3.",
  TELECEL: "No prompt? Dial *110#, 4, 2.",
  AT: "No prompt? Dial *110#, 6.",
  UNKNOWN: "",
}

export function quoteReply(i: QuoteInput): string {
  const price = i.feeOnTop ? `${formatGhs(i.amountGhs)} + MoMo charge` : formatGhs(i.amountGhs)
  return fitOneSegment([
    `${i.size} ${i.networkLabel} for ${i.recipientLocal}, ${price}.`,
    "Approve the MoMo prompt now.",
    PAYER_TIPS[i.payerNetwork],
    `Next time just text ${i.size}`,
  ])
}

export function unpaidReply(size: string): string {
  return fitOneSegment([
    "Payment didn't go through.",
    `Reply YES to try again, or text ${size}.`,
    "If you already approved, ignore this.",
  ])
}

export function deliveredGiftReply(size: string, recipientLocal: string): string {
  return fitOneSegment([`${size} sent to ${recipientLocal}.`, `Text ${size} to buy again.`])
}

export function paidNotDeliveredReply(): string {
  return fitOneSegment([
    "We received your payment but delivery is delayed.",
    "We are working on it and will update you.",
    "No need to pay again.",
  ])
}

/** The prompt's total changed after the quote (the charge fell back to a different price). The figure comes from the order row. */
export function repricedReply(amountGhs: number): string {
  return fitOneSegment([`Total is now ${formatGhs(amountGhs)}.`, "Approve the MoMo prompt or ignore it."])
}

export function lateReply(): string {
  return fitOneSegment(["Your message arrived late so we did not charge you.", "Please text again."])
}

export function limitedReply(): string {
  return fitOneSegment(["Too many requests.", "Please try again in 1 hour."])
}

export function openOrderReply(): string {
  return fitOneSegment(["Approve the MoMo prompt for your first order, or wait 5 minutes and text again."])
}

export function notUnderstoodReply(): string {
  return fitOneSegment([
    "To buy data, text the size e.g. 5GB.",
    "For someone else add the number: 5GB 0241234567.",
    "Text PRICES for the list.",
  ])
}

export function helpReply(): string {
  return notUnderstoodReply()
}

export function wrongNumberReply(): string {
  return fitOneSegment([
    "That phone number is not valid.",
    "Text the size and a 10-digit number, e.g. 5GB 0241234567.",
  ])
}

export function unavailableReply(networkLabel: string, nearest: SizePrice[]): string {
  const head = `That size is not available on ${networkLabel}.`
  if (nearest.length === 0) return fitOneSegment([head, "Text PRICES for the list."])
  // Drop whole nearest entries from the end until it fits.
  for (let n = nearest.length; n >= 1; n--) {
    const list = nearest
      .slice(0, n)
      .map((x) => `${x.size} ${formatGhs(x.priceGhs)}`)
      .join(", ")
    const text = `${head} Nearest: ${list}. Text one of these sizes.`
    if (fitsOneSegment(text)) return text
  }
  return fitOneSegment([head, "Text PRICES for the list."])
}

export function priceListReply(networkLabel: string, items: SizePrice[]): string {
  const prefix = `${networkLabel}:`
  let text = prefix
  for (let i = 0; i < items.length; i++) {
    const next = `${text} ${i + 1}) ${items[i].size} ${formatGhs(items[i].priceGhs)}`
    if (!fitsOneSegment(next)) break
    text = next
  }
  return text
}

export function priceAnswerReply(size: string, networkLabel: string, priceGhs: number): string {
  return fitOneSegment([`${networkLabel} ${size} is ${formatGhs(priceGhs)}.`, `Text ${size} to buy.`])
}

export function statusReply(
  s: "none" | "awaiting_payment" | "processing" | "delivered" | "failed",
  size?: string,
): string {
  const order = size ? `Your ${size} order` : "Your order"
  switch (s) {
    case "none":
      return fitOneSegment(["No recent order found.", "To buy data, text the size e.g. 5GB."])
    case "awaiting_payment":
      return fitOneSegment([`${order} is waiting for payment.`, "Approve the MoMo prompt."])
    case "processing":
      return fitOneSegment([`${order} is paid and being delivered.`, "Please wait a few minutes."])
    case "delivered":
      return fitOneSegment([`${order} was delivered.`])
    case "failed":
      return fitOneSegment([`${order} was not completed.`, size ? `Text ${size} to try again.` : "Text the size to try again."])
  }
}

const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand"
const PRICE_WORDS = "cost|costs|price|priced|pay|charge|fee|total|only|for|is"

/**
 * Allow-list money check for AI-written text. True when the text names a currency, or
 * contains ANY digit outside an allowed form (a size like 5GB / 1.5GB / 500MB, or a
 * list marker like "1)"). Phone numbers are not allowed. Spelled-out numbers (twenty,
 * fifty, hundred ...) are caught only when a price-like word (cost, price, pay, only,
 * for, is, at ...) also appears; a spelled number with no digit and no price word
 * ("which of the two?") passes. Over-blocking is the safe direction.
 */
export function containsMoney(text: string): boolean {
  if (/ghs|ghc|usd|₵|\$/i.test(text)) return true
  if (/\b(cedis?|pesewas?|dollars?)\b/i.test(text)) return true
  if (/\bgh\s*\d/i.test(text)) return true
  const stripped = text.replace(/\d+(\.\d+)?\s?(gb|mb)\b/gi, " ").replace(/(?<![\w.,(])[1-9]\)/g, " ")
  if (/\d/.test(stripped)) return true
  const numberWord = new RegExp(`\\b(${NUMBER_WORDS})\\b`, "i")
  const priceWord = new RegExp(`\\b(${PRICE_WORDS})\\b`, "i")
  // "at" is also the AT network name, so it only counts directly before a number word.
  const atNumber = new RegExp(`\\bat\\s+(${NUMBER_WORDS})\\b`, "i")
  return (numberWord.test(text) && priceWord.test(text)) || atNumber.test(text)
}

/** AI text if it states no money and fits one GSM-7 segment, else the safe fallback. */
export function safeAiQuestion(text: string): string {
  const t = text.trim()
  if (t.length === 0 || containsMoney(t) || !fitsOneSegment(t)) return notUnderstoodReply()
  return t
}
