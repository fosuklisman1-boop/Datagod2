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
import { lineEnabled, type TtbSettings } from "./settings"
import { makeShopLane, mainWrongLine, type ShopLane, type ShopLaneDeps } from "./shop/lane"
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
  /** The shop line's collaborators (shop lookups, shop adapter deps, credits); the real ones when absent. */
  shop?: ShopLaneDeps
  /** Dry run only: told whether the offer that was quoted is a gift (the admin try-it reports the credits it would reserve). */
  onDryOffer?: (offer: { gift?: boolean }) => void
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
  // The shop line starts with the read-only shop set (status, notices); its priced set is built once a shop has resolved.
  let adapters: Adapters = { ...makeAdapters({ resolve, confirm, shopData: deps.shop?.shopData }, i.line), ...deps.adapters }
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

  // The shop line's steps (null on the main line). Replies of a text whose shop has resolved are shop-paid unless the caller says
  // datagod: the shop's own hourly cap then replaces Datagod's global cap (shop-paid replies cost Datagod nothing).
  let lane: ShopLane | null = null

  async function finish(
    outcome: Outcome,
    text: string | null,
    extra: { orderLinkId?: string; orderId?: string; transactional?: boolean; datagod?: boolean } = {},
  ): Promise<InboundResult> {
    const shopPaid = lane !== null && !extra.datagod && lane.paysReplies()
    // Every reply goes through here, so the overall cap cannot be bypassed. The order quote ("prompted") and replies sent after
    // an order already exists and its MoMo prompt has started (transactional) are never held back.
    if (text && outcome !== "prompted" && !extra.transactional && (await (shopPaid ? lane!.capReached() : replyCapReached()))) {
      outcome = "limited"
      text = null
    }
    if (!dry) {
      if (text) await reply(db, { line: i.line, sender: i.from, body: text, settings, orderLinkId: extra.orderLinkId, ...(shopPaid ? { payer: lane!.payer() } : {}) })
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
    // The shop line has its own switch (the webhook gates both lines too; a stranded text recovered later is gated here).
    if (!dry && i.line === "shop" && !lineEnabled(settings, "shop")) return await finish("off", null)
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

    // Only the services that are switched on for texting are named to the customer. The shop line sells data only.
    const offered = i.line === "shop"
      ? { airtime: false, resultsChecker: false }
      : { airtime: settings.airtimeEnabled, resultsChecker: settings.resultsCheckerEnabled }

    if (i.line === "shop") {
      lane = makeShopLane({
        db, messageId, sender: i.from, text: i.text, now: i.now, dry, settings, deps: deps.shop ?? {}, alert, say: finish, remember,
        buildAdapters: (shop) => ({ ...makeAdapters({ resolve, confirm, shopData: deps.shop?.shopData }, "shop", shop), ...deps.adapters }),
      })
    }

    const priceList = async (outcome: "keyword" | "price_answer"): Promise<InboundResult> => {
      // The shop line has no price list of its own yet: never show the main catalogue's prices on it.
      if (i.line === "shop") return await finish(outcome, helpReply(offered), { datagod: true })
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
    // Shop line only: the shop of the last order, when AGAIN / YES retry it (the same shop is re-resolved, never another one).
    let retry: { shopCodeId: string | null } | null = null
    const lastShop = (): { shopCodeId: string | null } => ({
      shopCodeId: conv.lastOrder && !("service" in conv.lastOrder) ? (conv.lastOrder.shopCodeId ?? null) : null,
    })

    // Shop line: a shop code answering "Which shop?" completes the held read before anything else reads the text.
    const held = lane ? await lane.held(conv.pending) : null
    if (held && "done" in held) return held.done

    const picked = pickedOption(parsed, conv.pending) ?? pickedQuantity(parsed, conv.pending) ?? pickedAmount(i.text, conv.pending)
    if (held) {
      read = held.read
    } else if (picked) {
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
          if (lane) retry = lastShop()
          break
        case "YES": {
          if (conv.pending?.type === "confirm") {
            read = conv.pending.read
          } else if (!conv.pending && conv.lastOrder) {
            const link = await latestOrderLink(db, i.line, i.from)
            const unpaid = !!link && link.notices.includes("unpaid") && now - Date.parse(link.createdAt) <= CONVERSATION_WINDOW_MS
            read = unpaid ? rebuildFromLastOrder(conv.lastOrder) : NOT_ORDER
            if (lane) retry = lastShop()
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
    if (read.kind === "not_order" || read.kind === "unknown" || read.kind === "keyword") {
      // Main line, a text that is no order: a code of an active shop means the customer texted the wrong number.
      if (!dry && i.line === "main" && read.kind !== "keyword" && settings.shopNumber.trim()) {
        const wrong = await mainWrongLine({ db, sender: i.from, text: i.text, now: i.now, settings, deps: deps.shop ?? {} })
        if (wrong) return await finish("not_order", wrong === "silent" ? null : wrong.reply, { datagod: true })
      }
      return await notUnderstood()
    }
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

    // ---- shop line: which shop, its account and its reply cap --------------------------------------------------------
    // (Another service on the shop line has no adapter: it falls through to "not understood" without asking for a shop.)
    if (lane && (read.kind === "price_query" || read.service === "data")) {
      const stop = await lane.ensureShop(read, retry)
      if (stop) return stop
      adapters = lane.adapters()
    }

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
      if (lane) {
        // The shop's own verified price, not the main catalogue's.
        const text = lane.priceAnswer(offer)
        await remember(i.text, text, { pending: { type: "confirm", read: orderRead(read.sizeMb as number, read.networkHint, null) } })
        return await finish("price_answer", text)
      }
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
    if (dry) {
      deps.onDryOffer?.(offer as { gift?: boolean })
      return await finish("prompted", quote(offer.previewGhs, offer.previewDeliversGhs))
    }

    // Shop line: the shop must still be open and its credits are set aside BEFORE the order exists (a failure here is the pause
    // path: nothing placed, nothing prompted). The reserve comes before the pre-write below, which stays right before place().
    if (lane) {
      const stop = await lane.beforePlace(offer)
      if (stop) return stop
    }

    // Mark the row BEFORE placing. If this run dies after place() but before finish() records the real outcome, the row would
    // otherwise still look unprocessed (outcome null), and the recovery sweep would place a second order and send a second MoMo
    // prompt. With any outcome set, claimInbound and strandedInbound never pick the row again; finish() overwrites it. If the
    // mark cannot be written nothing is placed.
    try {
      await setInboundResult(db, messageId, { readBy, outcome: "error" })
    } catch (e) {
      console.error("[text-to-buy] pre-place mark error", { messageId, error: e instanceof Error ? e.name : "unknown" })
      await lane?.release()
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
    if (!orderId) {
      await lane?.release() // nothing was placed: the reserve goes back at once
      return await finish("unavailable", adapter.notPlacedReply(offer))
    }

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
        ...(lane ? { shopId: lane.shopId } : {}),
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
      await remember(i.text, text, { lastOrder: lane ? lane.lastOrder(offer.lastOrder) : offer.lastOrder })
      await lane?.afterOrder()
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
