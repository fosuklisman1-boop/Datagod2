import type { SupabaseClient } from "@supabase/supabase-js"
import { handleConfirm } from "@/lib/ussd/handlers/bundles"
import { isUssdHubtelPayer } from "@/lib/ussd/gateway-charge"
import { resolveSurfaceGateway } from "@/lib/payment-gateway/start"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { detectNetworkWithMap, ghanaSignificant } from "@/lib/phone-format"
import { notifyAdmins } from "@/lib/sms-service"
import { listPrices, resolveOffer, sizeLabel } from "./catalogue"
import { readWithAi } from "./ai-reader"
import { parseOrderText } from "./parse-rules"
import { helpReply, lateReply, limitedReply, notUnderstoodReply, openOrderReply, placedNeutralReply, priceAnswerReply, priceListReply, statusReply } from "./replies"
import { sendReply } from "./send-reply"
import { adapterForLink, makeAdapters, type Adapters } from "./services"
import type { DataOffer } from "./services/data"
import type { PlaceResult, ServiceOffer } from "./services/types"
import type { TtbSettings } from "./settings"
import {
  claimInbound, closeStaleLinks, counts, countOutbound, getInboundOutcome, globalPrompts, hasOpenOrder, isBlocked, latestOrderLink, linkByOrderId,
  linkOrder, loadConversation, saveConversation, setInboundResult, storeInbound, type Conversation,
} from "./store"
import { aiHistory, choicesFromPriceList, orderRead, orderStatusOf, pickedAmount, pickedOption, pickedQuantity, rebuildFromLastOrder } from "./inbound-steps"
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
  feeOnTop?: (offer: ServiceOffer) => Promise<boolean>
  /** Merged over makeAdapters({ resolve, confirm }): the per-service pricing, placing and notice code. */
  adapters?: Adapters
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
const REPLY_CAP_ALERT = "Text-to-Buy: hourly reply cap reached"

/**
 * When each line last alerted about the hourly reply cap. One alert per line per hour, measured on the injected clock, with no
 * re-arming when the count dips below the cap (that would alert once per aged-out reply). The state is per server instance, so
 * with several serverless instances each may alert once an hour at most: bounded, not exactly once.
 */
const capAlerted = new Map<Line, number>()
export function resetReplyCapAlert(): void {
  capAlerted.clear()
}

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
async function defaultFeeOnTop(chargePhone: string, offer: ServiceOffer): Promise<boolean> {
  try {
    const verifiedPayer = isUssdHubtelPayer({ chargePhone, ownerPhone: chargePhone, provider: offer.paystackProvider })
    const { gateway, feeBearer } = await resolveSurfaceGateway("sms_order", { verifiedPayer, amount: offer.previewGhs })
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
  const adapters: Adapters = { ...makeAdapters({ resolve, confirm }), ...deps.adapters }
  const reply = deps.reply ?? sendReply
  const alert = deps.alert ?? ((m: string) => notifyAdmins(m, "text_to_buy"))
  const now = i.now.getTime()
  let readBy: "rules" | "ai" | null = null

  /**
   * True when this non-quote reply must be suppressed because the line already sent its hourly cap of replies.
   * Fail safe: an unreadable count counts as reached (stay silent rather than spend blindly). Never throws.
   * A suppression alerts admins at most once per line per hour (never in a dry run).
   */
  async function replyCapReached(): Promise<boolean> {
    const cap = settings.globalRepliesPerHour
    let sent: number
    try {
      sent = await countOutbound(db, i.line, new Date(now - HOUR))
    } catch (e) {
      console.error("[text-to-buy] reply cap count error", { messageId, error: e instanceof Error ? e.name : "unknown" })
      return true
    }
    if (sent < cap) return false
    if (!dry) {
      const last = capAlerted.get(i.line)
      if (last === undefined || now - last >= HOUR) {
        capAlerted.set(i.line, now)
        try {
          await alert(REPLY_CAP_ALERT)
        } catch {
          // an alert must never throw out of the lane
        }
      }
    }
    return true
  }

  async function finish(
    outcome: Outcome,
    text: string | null,
    extra: { orderLinkId?: string; orderId?: string; transactional?: boolean } = {},
  ): Promise<InboundResult> {
    // Every reply goes through here, so the overall cap cannot be bypassed. The order quote ("prompted") and replies sent after
    // an order already exists and its MoMo prompt has started (transactional) are never held back.
    if (text && outcome !== "prompted" && !extra.transactional && (await replyCapReached())) {
      outcome = "limited"
      text = null
    }
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

    // Only the services that are switched on for texting are named to the customer.
    const offered = { airtime: settings.airtimeEnabled, resultsChecker: settings.resultsCheckerEnabled }

    const priceList = async (outcome: "keyword" | "price_answer"): Promise<InboundResult> => {
      const list = await prices(db, i.from)
      if (!list) return await finish(outcome, helpReply(offered))
      const text = priceListReply(list.networkLabel, list.items)
      await remember(i.text, text, { pending: choicesFromPriceList(list.items, text) })
      return await finish(outcome, text)
    }

    // ---- 4. read the text -------------------------------------------------------------------------------------------
    readBy = "rules"
    let parsed = parseOrderText(i.text)
    // A rules airtime or voucher read for a service whose text switch is off is not decided here: the text gets the normal
    // Stage 1 treatment (the AI step, which also never offers a service that is off).
    if (parsed.kind === "order" && ((parsed.service === "airtime" && !offered.airtime) || (parsed.service === "results_checker" && !offered.resultsChecker))) {
      parsed = { kind: "unknown" }
    }
    let read: ReadResult = parsed

    const picked = pickedOption(parsed, conv.pending) ?? pickedQuantity(parsed, conv.pending) ?? pickedAmount(i.text, conv.pending)
    if (picked) {
      read = picked
    } else if (parsed.kind === "keyword") {
      switch (parsed.keyword) {
        case "PRICES":
          return await priceList("keyword")
        case "HELP":
          return await finish("keyword", helpReply(offered))
        case "STATUS": {
          const link = await latestOrderLink(db, i.line, i.from)
          // The order row is read from the table the link names, through its own service's adapter. A pair with no adapter is
          // never read from another table: it reports from the link alone.
          const adapter = link ? adapterForLink(adapters, link) : null
          const status = link && adapter ? adapter.statusOf(link, await adapter.readOrder(db, link.orderId)) : orderStatusOf(link, null)
          return await finish("keyword", statusReply(status, link ? sizeLabel(link.size) : undefined))
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
        read = await withinBudget(readAi(i.text, aiHistory(conv.turns), { offered }))
      }
    }

    // ---- 5-7. things that are not an order -------------------------------------------------------------------------
    // With the switch off an unclear text costs nothing: no reply at all.
    const notUnderstood = () => finish("not_order", !settings.unclearRepliesEnabled || c.notUnderstood >= 1 ? null : notUnderstoodReply(offered))
    if (read.kind === "not_order" || read.kind === "unknown" || read.kind === "keyword") return await notUnderstood()
    if (read.kind === "ask") {
      // Defence in depth (the AI reader already refuses): a question that waits for an answer about a service that is off is
      // never asked and never remembered, so the next bare number cannot be swallowed or turned into an order.
      if ((read.awaitAmount && !offered.airtime) || (read.awaitBoard && !offered.resultsChecker)) return await notUnderstood()
      const pending: Conversation["pending"] = read.awaitBoard
        ? { type: "quantity", board: read.awaitBoard }
        : read.awaitAmount
          ? { type: "amount", network: read.awaitAmount.network }
          : null
      await remember(i.text, read.question, pending ? { pending } : {})
      return await finish("asked", read.question)
    }
    if (read.kind === "price_query" && read.sizeMb === null) return await priceList("price_answer")

    // ---- 7-8. price a size ------------------------------------------------------------------------------------------
    const orderForOffer =
      read.kind === "order" ? read : orderRead(read.sizeMb as number, read.networkHint, null)
    // A price question is data-only; an order goes to its own service's adapter. No adapter, or its text switch off: not understood.
    const adapter = adapters[read.kind === "price_query" ? "data" : read.service]
    if (!adapter || !adapter.textEnabled(settings)) return await notUnderstood()
    const res = await adapter.resolve(db, i.from, orderForOffer)

    if (!res.ok) {
      const r = res.refusal
      if (r.remember) await remember(i.text, r.reply, r.pending ? { pending: r.pending } : {})
      return await finish(r.outcome, r.reply)
    }
    const offer = res.offer

    if (read.kind === "price_query") {
      // Only data has a price answer; any other offer here is a wiring mistake, so it is not understood rather than read as data.
      if (offer.service !== "data") return await notUnderstood()
      const d = (offer as DataOffer).offer
      const text = priceAnswerReply(sizeLabel(d.size), d.networkLabel, d.price)
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

    // The sender in international form: the phone the gateway lookup treats as the payer.
    const chargePhone = "+233" + ghanaSignificant(i.from)
    let feeOnTop = false
    try {
      feeOnTop = await (deps.feeOnTop ?? ((o: ServiceOffer) => defaultFeeOnTop(chargePhone, o)))(offer)
    } catch {
      feeOnTop = false
    }
    let payerNetwork: "MTN" | "TELECEL" | "AT" | "UNKNOWN" = "UNKNOWN"
    try {
      payerNetwork = detectNetworkWithMap(i.from, (await getPrefixValidationConfig()).map)
    } catch {
      payerNetwork = "UNKNOWN"
    }
    const quote = (amountGhs: number, deliversGhs?: number) =>
      adapter.quote(offer, { amountGhs, ...(deliversGhs === undefined ? {} : { deliversGhs }) }, { feeOnTop, payerNetwork })

    // The preview can only know the offer price: the charged amount is fixed when the order row is written.
    if (dry) return await finish("prompted", quote(offer.previewGhs, offer.previewDeliversGhs))

    // Mark the row BEFORE placing. If this run dies after place() but before finish() records the real outcome, the row would
    // otherwise still look unprocessed (outcome null), and the recovery sweep would place a second order and send a second MoMo
    // prompt. With any outcome set, claimInbound and strandedInbound never pick the row again; finish() overwrites it. If the
    // mark cannot be written nothing is placed.
    try {
      await setInboundResult(db, messageId, { readBy, outcome: "error" })
    } catch (e) {
      console.error("[text-to-buy] pre-place mark error", { messageId, error: e instanceof Error ? e.name : "unknown" })
      return await finish("unavailable", adapter.notPlacedReply(offer))
    }

    let placed: PlaceResult
    try {
      placed = await adapter.place(offer, messageId, i.from)
    } catch (e) {
      // Whether an order was written is unknown, so nothing is claimed and nothing is retried: the inbound row ends as "error"
      // (the sweep does not run it again), and the admins hear once. No order id, phone, text or amount in the alert.
      console.error("[text-to-buy] place error", { messageId, error: e instanceof Error ? e.name : "unknown" })
      try {
        await alert(`Text-to-Buy: placing an order failed unexpectedly: message ${messageId}`)
      } catch {
        // an alert must never throw out of the lane
      }
      throw e
    }
    const orderId = placed.orderId
    if (!orderId) return await finish("unavailable", adapter.notPlacedReply(offer))

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
    const amount = placed.amountGhs
    // An airtime quote states two figures, so the delivered amount must be usable as well. Data keeps its one figure.
    const unusable =
      typeof amount !== "number" || !Number.isFinite(amount) || (adapter.service === "airtime" && !(typeof placed.deliversGhs === "number" && Number.isFinite(placed.deliversGhs)))
    if (unusable || typeof amount !== "number") {
      await alertOrder("order placed without a usable amount")
      const text = adapter.service === "data" ? adapter.notPlacedReply(offer) : placedNeutralReply()
      return await finish("unavailable", text, { transactional: true })
    }

    let linked: { id: string } | "race" | "link_failed"
    try {
      const l = await linkOrder(db, {
        line: i.line, sender: i.from, service: adapter.service, orderTable: adapter.orderTable, orderId, size: offer.size, recipient: offer.recipientLocal, gift: offer.gift, amount,
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
      return await finish("open_order", openOrderReply(), { transactional: true })
    }
    if (linked === "link_failed") {
      // The order and its prompt are real, so the quote is accurate: send it. There is no link row, so no follow-up SMS.
      await alertOrder("order placed but link failed")
      return await finish("prompted", quote(amount, placed.deliversGhs), { orderId })
    }

    // The quote goes out first; remembering the conversation is best-effort and never suppresses it.
    const text = quote(amount, placed.deliversGhs)
    const result = await finish("prompted", text, { orderLinkId: linked.id, orderId })
    try {
      await remember(i.text, text, { lastOrder: offer.lastOrder })
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
