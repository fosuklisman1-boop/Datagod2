import type { SupabaseClient } from "@supabase/supabase-js"
import { handleConfirm } from "@/lib/ussd/handlers/bundles"
import { isUssdHubtelPayer } from "@/lib/ussd/gateway-charge"
import { resolveSurfaceGateway } from "@/lib/payment-gateway/start"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { detectNetworkWithMap } from "@/lib/phone-format"
import { notifyAdmins } from "@/lib/sms-service"
import { listPrices, resolveOffer, sessionForOffer, sizeLabel, type Offer, type OfferResult } from "./catalogue"
import { readWithAi } from "./ai-reader"
import { parseOrderText } from "./parse-rules"
import {
  helpReply, lateReply, limitedReply, notUnderstoodReply, openOrderReply, priceAnswerReply, priceListReply, quoteReply, statusReply,
  unavailableReply, wrongNumberReply, fitOneSegment,
} from "./replies"
import { sendReply } from "./send-reply"
import type { TtbSettings } from "./settings"
import {
  claimInbound, closeStaleLinks, counts, getInboundOutcome, globalPrompts, hasOpenOrder, isBlocked, latestOrderLink, linkByOrderId,
  linkOrder, loadConversation, saveConversation, setInboundResult, storeInbound, ussdOrderStatus, type Conversation,
} from "./store"
import {
  aiHistory, choicesFromPriceList, dedupeNearest, lastOrderOf, orderRead, orderStatusOf, pickedOption, productQuestion, rebuildFromLastOrder,
} from "./inbound-steps"
import type { Line, Outcome, ReadResult } from "./types"

/**
 * The Text-to-Buy lane. Server-only.
 * acceptInbound is awaited by the webhook (store the row); processInbound runs in after() and never throws.
 * Every window and limit is computed from i.now, never from the wall clock. Customer text, phone numbers and model output
 * are never logged: an unexpected error logs the message row id and the error name only.
 */

export type InboundInput = { line: Line; from: string; text: string; receivedAt: Date | null; now: Date }
export type InboundDeps = {
  readAi?: typeof readWithAi
  resolve?: typeof resolveOffer
  prices?: typeof listPrices
  confirm?: typeof handleConfirm
  reply?: typeof sendReply
  alert?: (message: string) => Promise<void>
  feeOnTop?: (offer: Offer) => Promise<boolean>
  /** Try-it: no writes, no SMS, no order. The result carries the reply that would be sent. */
  dryRun?: boolean
}
export type InboundResult = { outcome: Outcome; readBy: "rules" | "ai" | null; reply: string | null; orderId?: string }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const FUTURE_SKEW_MS = 2 * MINUTE
const CONVERSATION_WINDOW_MS = 20 * MINUTE // the same 20 minutes saveConversation keeps a conversation alive
const AI_BUDGET_MS = 10_000
const NOT_ORDER: ReadResult = { kind: "not_order" }
const CAP_ALERT = "Text-to-Buy: global prompt cap reached"

/** Phase 1, awaited by the webhook. processed = this message already has a recorded outcome (a retry after a crash is not). */
export async function acceptInbound(db: SupabaseClient, i: InboundInput): Promise<{ id: string; duplicate: boolean; processed: boolean }> {
  const row = await storeInbound(db, { line: i.line, sender: i.from, body: i.text, receivedAt: i.receivedAt, now: i.now })
  if (!row.duplicate) return { id: row.id, duplicate: false, processed: false }
  return { id: row.id, duplicate: true, processed: (await getInboundOutcome(db, row.id)) !== null }
}

async function withinBudget(p: Promise<ReadResult>): Promise<ReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<ReadResult>((resolve) => {
    timer = setTimeout(() => resolve(NOT_ORDER), AI_BUDGET_MS)
  })
  try {
    return await Promise.race([p.catch(() => NOT_ORDER), budget])
  } finally {
    clearTimeout(timer)
  }
}

/** The surface the charge will use for this payer, and who pays the gateway's own charge. Unknown means say so. */
async function defaultFeeOnTop(chargePhone: string, offer: Offer): Promise<boolean> {
  try {
    const verifiedPayer = isUssdHubtelPayer({ chargePhone, ownerPhone: chargePhone, provider: offer.paystackProvider })
    const { gateway, feeBearer } = await resolveSurfaceGateway("sms_order", { verifiedPayer, amount: offer.price })
    return gateway === "hubtel" && feeBearer === "customer"
  } catch {
    return true
  }
}

export async function processInbound(
  db: SupabaseClient,
  messageId: string,
  i: InboundInput,
  settings: TtbSettings,
  deps: InboundDeps = {},
): Promise<InboundResult> {
  const dry = deps.dryRun === true
  const readAi = deps.readAi ?? readWithAi
  const resolve = deps.resolve ?? resolveOffer
  const prices = deps.prices ?? listPrices
  const confirm = deps.confirm ?? handleConfirm
  const reply = deps.reply ?? sendReply
  const alert = deps.alert ?? ((m: string) => notifyAdmins(m, "text_to_buy"))
  const now = i.now.getTime()
  let readBy: "rules" | "ai" | null = null

  async function finish(outcome: Outcome, text: string | null, extra: { orderLinkId?: string; orderId?: string } = {}): Promise<InboundResult> {
    if (!dry) {
      if (text) await reply(db, { line: i.line, sender: i.from, body: text, settings, orderLinkId: extra.orderLinkId })
      await setInboundResult(db, messageId, { readBy, outcome, orderLinkId: extra.orderLinkId })
    }
    return { outcome, readBy, reply: text, ...(!dry && extra.orderId ? { orderId: extra.orderId } : {}) }
  }

  // The lease comes first: a retry that overlaps a running (or crashed, within the lease) run must not place a second order.
  // A failed claim records nothing, so the forwarder's retry can still be processed.
  if (!dry) {
    try {
      if (!(await claimInbound(db, messageId, i.now))) return { outcome: "duplicate", readBy: null, reply: null }
    } catch (e) {
      console.error("[text-to-buy] inbound error", { messageId, error: e instanceof Error ? e.name : "unknown" })
      return { outcome: "error", readBy: null, reply: null }
    }
  }

  try {
    if (await isBlocked(db, i.from)) return await finish("blocked", null)

    // A receive time more than 2 minutes ahead of us is a bad clock, not a fresh message: treat it as absent.
    const sent = i.receivedAt && i.receivedAt.getTime() - now <= FUTURE_SKEW_MS ? i.receivedAt : null
    if (sent && now - sent.getTime() > settings.staleMinutes * MINUTE) return await finish("late", lateReply())

    const c = await counts(db, i.line, i.from, new Date(now - HOUR))
    if (c.replies >= settings.repliesPerHour) return await finish("limited", null)

    const conv = await loadConversation(db, i.line, i.from, i.now)

    const remember = async (text: string, assistant: string, patch: { pending?: Conversation["pending"]; lastOrder?: Conversation["lastOrder"] } = {}) => {
      if (dry) return
      await saveConversation(
        db, i.line, i.from,
        {
          turns: [...conv.turns, { role: "user", text: i.text }, { role: "assistant", text: assistant }],
          pending: patch.pending ?? null,
          lastOrder: patch.lastOrder === undefined ? conv.lastOrder : patch.lastOrder,
        },
        i.now,
      )
    }

    const priceList = async (outcome: "keyword" | "price_answer"): Promise<InboundResult> => {
      const list = await prices(db, i.from)
      if (!list) return await finish(outcome, helpReply())
      const text = priceListReply(list.networkLabel, list.items)
      await remember(i.text, text, { pending: choicesFromPriceList(list.items, text) })
      return await finish(outcome, text)
    }

    // ---- 4. read the text -------------------------------------------------------------------------------------------
    readBy = "rules"
    const parsed = parseOrderText(i.text)
    let read: ReadResult = parsed

    const picked = pickedOption(parsed, conv.pending)
    if (picked) {
      read = picked
    } else if (parsed.kind === "keyword") {
      switch (parsed.keyword) {
        case "PRICES":
          return await priceList("keyword")
        case "HELP":
          return await finish("keyword", helpReply())
        case "STATUS": {
          const link = await latestOrderLink(db, i.line, i.from)
          const ussd = link ? await ussdOrderStatus(db, link.orderId) : null
          return await finish("keyword", statusReply(orderStatusOf(link, ussd), link ? sizeLabel(link.size) : undefined))
        }
        case "AGAIN":
          read = conv.lastOrder ? rebuildFromLastOrder(conv.lastOrder) : NOT_ORDER
          break
        case "YES": {
          if (conv.pending?.type === "confirm") {
            read = conv.pending.read
          } else if (!conv.pending && conv.lastOrder) {
            const link = await latestOrderLink(db, i.line, i.from)
            const unpaid = !!link && link.notices.includes("unpaid") && now - Date.parse(link.createdAt) <= CONVERSATION_WINDOW_MS
            read = unpaid ? rebuildFromLastOrder(conv.lastOrder) : NOT_ORDER
          } else {
            read = NOT_ORDER
          }
          break
        }
      }
    } else if (parsed.kind === "unknown") {
      if (!settings.aiEnabled || c.aiReads >= settings.aiReadsPerHour) {
        read = NOT_ORDER
      } else {
        readBy = "ai"
        read = await withinBudget(readAi(i.text, aiHistory(conv.turns)))
      }
    }

    // ---- 5-7. things that are not an order -------------------------------------------------------------------------
    if (read.kind === "not_order" || read.kind === "unknown" || read.kind === "keyword") {
      return await finish("not_order", c.notUnderstood >= 1 ? null : notUnderstoodReply())
    }
    if (read.kind === "ask") {
      await remember(i.text, read.question)
      return await finish("asked", read.question)
    }
    if (read.kind === "price_query" && read.sizeMb === null) return await priceList("price_answer")

    // ---- 7-8. price a size ------------------------------------------------------------------------------------------
    const orderForOffer =
      read.kind === "order" ? read : orderRead(read.sizeMb as number, read.networkHint, null)
    const res: OfferResult = await resolve(db, {
      senderLocal: i.from, sizeMb: orderForOffer.sizeMb, networkHint: orderForOffer.networkHint, recipient: orderForOffer.recipient,
    })

    if (!res.ok) {
      switch (res.reason) {
        case "choose_product": {
          const q = productQuestion(res.options, orderForOffer)
          await remember(i.text, q.question, { pending: q.pending })
          return await finish("asked", q.question)
        }
        case "need_recipient": {
          const q = fitOneSegment([`Which ${res.networkLabel} number should receive it?`])
          await remember(i.text, q)
          return await finish("asked", q)
        }
        case "bad_recipient": {
          const q = wrongNumberReply()
          await remember(i.text, q)
          return await finish("asked", q)
        }
        case "no_package":
          return await finish("unavailable", unavailableReply(res.networkLabel, dedupeNearest(res.nearest)))
        default:
          return await finish("unavailable", unavailableReply("this network", []))
      }
    }
    const offer = res.offer

    if (read.kind === "price_query") {
      const text = priceAnswerReply(sizeLabel(offer.size), offer.networkLabel, offer.price)
      await remember(i.text, text, { pending: { type: "confirm", read: orderRead(read.sizeMb as number, read.networkHint, null) } })
      return await finish("price_answer", text)
    }

    // ---- 9. place the order -----------------------------------------------------------------------------------------
    if (c.promptsUnpaid >= settings.promptsPerHour) return await finish("limited", limitedReply())

    const windowStart = new Date(now - settings.promptWindowMinutes * MINUTE)
    if (!dry) await closeStaleLinks(db, i.line, i.from, windowStart, i.now)
    if (await hasOpenOrder(db, i.line, i.from, windowStart)) return await finish("open_order", openOrderReply())

    const cap = settings.globalPromptsPerMinute
    const lastMinute = await globalPrompts(db, new Date(now - MINUTE))
    if (lastMinute >= cap) {
      if (!dry) {
        const before = (await globalPrompts(db, new Date(now - 2 * MINUTE))) - lastMinute
        if (before < cap) await alert(CAP_ALERT).catch(() => {})
      }
      return await finish("limited", limitedReply())
    }

    const session = sessionForOffer(i.from, offer)
    let feeOnTop = false
    try {
      feeOnTop = await (deps.feeOnTop ?? ((o: Offer) => defaultFeeOnTop(session.dialingPhone as string, o)))(offer)
    } catch {
      feeOnTop = false
    }
    let payerNetwork: "MTN" | "TELECEL" | "AT" | "UNKNOWN" = "UNKNOWN"
    try {
      payerNetwork = detectNetworkWithMap(i.from, (await getPrefixValidationConfig()).map)
    } catch {
      payerNetwork = "UNKNOWN"
    }
    // A written amount above the offer price is a Paystack-priced row: it already holds the fee, so "+ MoMo charge" would
    // state it twice. (feeOnTop is resolved before confirm and independently of it.)
    const quote = (amountGhs: number) =>
      quoteReply({
        size: sizeLabel(offer.size), networkLabel: offer.networkLabel, recipientLocal: offer.recipientLocal, amountGhs,
        feeOnTop: feeOnTop && !(amountGhs > offer.price + 0.005), payerNetwork,
      })

    // The preview can only know the offer price: the charged amount is fixed when the order row is written.
    if (dry) return await finish("prompted", quote(offer.price))

    // The session id is opaque on purpose: lib/ussd/session.ts logs it when Redis fails, so it must carry no phone number or text.
    const response = await confirm("1", `sms:${messageId}`, session, "sms", { momoOnly: true })
    const orderId = response.orderId
    if (!orderId) return await finish("unavailable", unavailableReply(offer.networkLabel, []))

    // From here an order exists and its MoMo charge has ALREADY started (confirm schedules it). Failing the row would not stop
    // the prompt or the payment, and a payment for a failed row is silently ignored: so the order is never failed. A paid one is
    // fulfilled by the normal path. Admins get the order id only (no phone, text or amount).
    const alertOrder = async (what: string) => {
      try {
        await alert(`Text-to-Buy: ${what}: ${orderId}`)
      } catch {
        // an alert must never throw out of the lane
      }
    }
    const amount = response.amount
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      await alertOrder("order placed without a usable amount")
      return await finish("unavailable", unavailableReply(offer.networkLabel, []))
    }

    let linked: { id: string } | "race" | "link_failed"
    try {
      const l = await linkOrder(db, {
        line: i.line, sender: i.from, orderId, size: offer.size, recipient: offer.recipientLocal, gift: offer.gift, amount,
      })
      linked = l === "conflict" ? (await linkByOrderId(db, orderId)) ?? "race" : l
    } catch (e) {
      console.error("[text-to-buy] link error", { messageId, error: e instanceof Error ? e.name : "unknown" })
      linked = "link_failed"
    }
    if (linked === "race") {
      // Another text won the open-order slot. A prompt is already out for this row; if the customer approves both they pay
      // twice and both orders are fulfilled (see the runbook).
      await alertOrder("duplicate order left pending (open-order race)")
      return await finish("open_order", openOrderReply())
    }
    if (linked === "link_failed") {
      // The order and its prompt are real, so the quote is accurate: send it. There is no link row, so no follow-up SMS.
      await alertOrder("order placed but link failed")
      return await finish("prompted", quote(amount), { orderId })
    }

    // The quote goes out first; remembering the conversation is best-effort and never suppresses it.
    const text = quote(amount)
    const result = await finish("prompted", text, { orderLinkId: linked.id, orderId })
    try {
      await remember(i.text, text, { lastOrder: lastOrderOf(offer, orderForOffer.sizeMb) })
    } catch (e) {
      console.error("[text-to-buy] conversation save error", { messageId, error: e instanceof Error ? e.name : "unknown" })
    }
    return result
  } catch (e) {
    console.error("[text-to-buy] inbound error", { messageId, error: e instanceof Error ? e.name : "unknown" })
    if (!dry) await setInboundResult(db, messageId, { readBy, outcome: "error" }).catch(() => {})
    return { outcome: "error", readBy, reply: null }
  }
}
