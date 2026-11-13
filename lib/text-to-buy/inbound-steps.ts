// Pure helpers for the Text-to-Buy orchestrator (handle-inbound.ts): no I/O, no clock, no randomness.

import type { Offer } from "./catalogue"
import { parseSizeMb, sizeLabel } from "./catalogue"
import { fitOneSegment } from "./replies"
import type { Conversation, LastOrder, Pending } from "./store"
import type { NetworkHint, ReadResult } from "./types"

type Turn = Conversation["turns"][number]
type OrderRead = Extract<ReadResult, { kind: "order" }>

const MAX_AI_HISTORY = 6

export const orderRead = (sizeMb: number, networkHint: NetworkHint | null, recipient: string | null): OrderRead => ({
  kind: "order", service: "data", sizeMb, networkHint, recipient, bare: false,
})

/** What the AI sees: the last 6 turns, and never starting with an assistant turn (some providers reject that). */
export function aiHistory(turns: Turn[]): Turn[] {
  const last = turns.slice(-MAX_AI_HISTORY)
  const firstUser = last.findIndex((t) => t.role === "user")
  return firstUser < 0 ? [] : last.slice(firstUser)
}

/** The bare digit a customer typed to pick a numbered option, if it names one that was offered. */
export function pickedOption(read: ReadResult, pending: Pending | null): ReadResult | null {
  if (read.kind !== "order" || !read.bare || pending?.type !== "choices") return null
  const n = read.sizeMb / 1000
  return Number.isInteger(n) && n >= 1 && n <= pending.options.length ? pending.options[n - 1].read : null
}

export function rebuildFromLastOrder(last: LastOrder): OrderRead {
  return orderRead(last.sizeMb, last.network as NetworkHint, last.recipient)
}

export function lastOrderOf(offer: Offer, fallbackSizeMb: number): LastOrder {
  return { sizeMb: parseSizeMb(offer.size) ?? fallbackSizeMb, network: offer.network, recipient: offer.recipientLocal }
}

/**
 * Numbered choices for a price list. priceListReply drops items that do not fit one segment, so only the numbers that
 * appear in the text are offered: "3" must never pick something the customer was not shown.
 */
export function choicesFromPriceList(
  items: { size: string; priceGhs: number }[],
  listText: string,
): Pending {
  const shown = (listText.match(/ \d+\) /g) ?? []).length
  const options = items.slice(0, shown).map((item) => {
    const [sizeToken, product] = item.size.split(" ")
    const hint: NetworkHint | null = product === "iShare" ? "AT-iShare" : product === "BigTime" ? "AT-BigTime" : null
    return { label: item.size, read: orderRead(parseSizeMb(sizeToken) ?? 0, hint, null) }
  })
  return { type: "choices", options: options.filter((o) => (o.read as OrderRead).sizeMb > 0) }
}

const productName = (o: Offer) => (o.network === "AT-iShare" ? "AT iShare" : o.network === "AT-BigTime" ? "AT BigTime" : o.networkLabel)

/** "Which one? 1) AT iShare 5GB 2) AT BigTime 5GB" plus the choices that digit picks. */
export function productQuestion(options: Offer[], read: OrderRead): { question: string; pending: Pending } {
  const labels = options.map((o, k) => `${k + 1}) ${productName(o)} ${sizeLabel(o.size)}`)
  return {
    question: fitOneSegment(["Which one?", ...labels]),
    pending: {
      type: "choices",
      options: options.map((o, k) => ({ label: labels[k], read: { ...read, networkHint: o.network, bare: false } })),
    },
  }
}

/** Nearest sizes with each size listed once (the cheapest first): AT merges two products that can share a size. */
export function dedupeNearest(nearest: { size: string; priceGhs: number }[]): { size: string; priceGhs: number }[] {
  const seen = new Set<string>()
  return nearest.filter((n) => (seen.has(n.size) ? false : (seen.add(n.size), true)))
}

export type OrderStatus = "none" | "awaiting_payment" | "processing" | "delivered" | "failed"

export function orderStatusOf(
  link: { state: string } | null,
  ussd: { orderStatus: string; paymentStatus: string } | null,
): OrderStatus {
  if (!link) return "none"
  if (!ussd) return link.state === "paid" ? "processing" : link.state === "closed" ? "failed" : "awaiting_payment"
  const { orderStatus: o, paymentStatus: p } = ussd
  if (o === "completed") return "delivered"
  if (o === "failed" || o === "expired" || p === "failed" || p === "expired") return "failed"
  if (o === "processing" || p === "paid" || p === "completed") return "processing"
  return link.state === "closed" ? "failed" : "awaiting_payment"
}
