import { airtimeBaseFeeRate, detectAirtimeNetwork, getAirtimeLimits, isAirtimeEnabled, splitInclusive, type AirtimeNetwork } from "@/lib/airtime-pricing"
import { isRecipientBlocked } from "@/lib/mtn-providers/customer-verification"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { dialerGetsDealerRate } from "@/lib/sub-agents/dealer-rates"
import { detectNetworkWithMap, ghanaSignificant, normalizeGhanaPhone } from "@/lib/phone-format"
import { confirmAirtimeByText } from "@/lib/ussd/handlers/airtime"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { resolveDialer } from "@/lib/ussd/resolve-dialer"
import type { USSDSession } from "@/lib/ussd/types"
import {
  airtimeGiftDeliveredReply, airtimeLimitsReply, airtimeNetworkQuestion, airtimeOffReply, airtimeQuoteReply, airtimeWrongNumberReply, amountToken,
  delayedReply, fitOneSegment, notUnderstoodReply, placedNeutralReply, unpaidReply,
} from "../replies"
import { orderRowFor, type Pending } from "../store"
import type { OrderRead } from "../types"
import { classifyStatusOrder } from "./classify"
import type { Refusal, ServiceAdapter, ServiceOffer } from "./types"

/**
 * The airtime service of the SMS lane. The customer types the amount; code prices it (the AI never does) and the confirm step
 * (confirmAirtimeByText) writes the order. The amount quoted, stored and charged is the one the order row holds.
 */
export type AirtimeOffer = ServiceOffer & { service: "airtime"; network: AirtimeNetwork; amountGhs: number }

type AirtimeDeps = { confirm?: typeof confirmAirtimeByText }
type AirtimeRead = Extract<OrderRead, { service: "airtime" }>

const NETWORKS: readonly AirtimeNetwork[] = ["MTN", "Telecel", "AT"]
const FROM_CARRIER = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" } as const
const PROVIDER_OF: Record<AirtimeNetwork, AirtimeOffer["paystackProvider"]> = { MTN: "mtn", Telecel: "vod", AT: "tgo" }
const UNAVAILABLE = "Airtime is not available now."

/** The staged session the confirm step reads: only what it needs, no wallet, user or cashback field. */
export function airtimeSession(senderLocal: string, o: AirtimeOffer): USSDSession {
  return {
    step: "AIRTIME_CONFIRM",
    dialingPhone: "+233" + ghanaSignificant(senderLocal),
    airtimeNetwork: o.network,
    airtimeRecipient: o.recipientLocal,
    airtimeAmount: o.amountGhs,
  } as USSDSession
}

const refuse = (outcome: Refusal["outcome"], reply: string, remember = false, pending?: Pending): { ok: false; refusal: Refusal } => ({
  ok: false,
  refusal: { outcome, reply, remember, ...(pending ? { pending } : {}) },
})

function networkChoices(read: AirtimeRead): Pending {
  return {
    type: "choices",
    options: NETWORKS.map((n, k) => ({ label: `${k + 1}) ${n}`, read: { ...read, networkHint: n } satisfies AirtimeRead })),
  }
}

export function airtimeAdapter(deps: AirtimeDeps = {}): ServiceAdapter<AirtimeOffer> {
  return {
    service: "airtime",
    orderTable: "airtime_orders",
    textEnabled: (s) => s.airtimeEnabled,

    async resolve(_db, senderLocal, read) {
      // The lane routes by read.service, so this is unreachable; it keeps the type honest and fails closed.
      if (read.kind !== "order" || read.service !== "airtime") return refuse("unavailable", notUnderstoodReply())
      try {
        const sender = ghanaSignificant(senderLocal)
        if (!sender) return refuse("unavailable", UNAVAILABLE)
        const typed = read.recipient !== null
        const recipient = typed ? normalizeGhanaPhone(read.recipient as string) : "0" + sender
        if (!recipient) return refuse("asked", airtimeWrongNumberReply(), true)
        const gift = recipient !== "0" + sender

        const map = (await getPrefixValidationConfig()).map
        const carrier = detectNetworkWithMap(recipient, map)
        const detected: AirtimeNetwork | null = carrier !== "UNKNOWN" ? FROM_CARRIER[carrier] : detectAirtimeNetwork(recipient)
        const hint = read.networkHint
        if (detected && hint && hint !== detected) {
          return typed ? refuse("asked", airtimeWrongNumberReply(), true) : refuse("asked", fitOneSegment([`Which ${hint} number should receive it?`]), true)
        }
        const network = detected ?? hint
        if (!network) return refuse("asked", airtimeNetworkQuestion(), true, networkChoices(read))

        if (network === "MTN" && (await isRecipientBlocked("MTN", recipient))) return refuse("asked", airtimeWrongNumberReply(), true)
        if (!(await isAirtimeEnabled(network))) return refuse("unavailable", airtimeOffReply(network))

        const amount = read.amountGhs
        const { min, max } = await getAirtimeLimits()
        // Written so that NaN fails: a comparison with NaN is false, which would otherwise let it through.
        const usable = Number.isFinite(amount) && Math.round(amount * 100) / 100 === amount && amount >= min && amount <= max
        if (!usable) return refuse("unavailable", airtimeLimitsReply(min, max))

        const dialer = await resolveDialer("+233" + sender)
        const { toDeliver } = splitInclusive(amount, await airtimeBaseFeeRate(network, dialerGetsDealerRate(dialer)))
        const token = "airtime " + amountToken(amount)
        const offer: AirtimeOffer = {
          service: "airtime",
          network,
          amountGhs: amount,
          // A gift keeps the number in its re-text token, so "text airtime 10" never silently becomes an own-number order.
          size: gift ? `${token} ${recipient}` : token,
          recipientLocal: recipient,
          gift,
          previewGhs: amount,
          previewDeliversGhs: toDeliver,
          paystackProvider: paystackProviderFromPhone("+233" + sender) ?? PROVIDER_OF[network],
          lastOrder: { service: "airtime", amountGhs: amount, network, recipient },
        }
        return { ok: true, offer }
      } catch (e) {
        console.error("[text-to-buy] airtime resolve error", { error: e instanceof Error ? e.name : "unknown" })
        return refuse("unavailable", UNAVAILABLE)
      }
    },

    async place(offer, messageId, senderLocal) {
      // The session id is opaque on purpose: lib/ussd/session.ts logs it when Redis fails, so it must carry no phone number or text.
      const r = await (deps.confirm ?? confirmAirtimeByText)(`sms:${messageId}`, airtimeSession(senderLocal, offer))
      return { orderId: r.orderId, amountGhs: r.amount, deliversGhs: r.delivers }
    },

    quote(offer, a, ctx) {
      // Only the placed amounts are ever stated. Without a usable delivered amount no money is stated at all.
      if (!Number.isFinite(a.amountGhs) || typeof a.deliversGhs !== "number" || !Number.isFinite(a.deliversGhs)) return placedNeutralReply()
      return airtimeQuoteReply({
        networkLabel: offer.network,
        recipientLocal: offer.recipientLocal,
        payGhs: a.amountGhs,
        getsGhs: a.deliversGhs,
        // A written amount above the preview already holds the gateway charge: "+ MoMo charge" would state it twice.
        feeOnTop: ctx.feeOnTop && !(a.amountGhs > offer.previewGhs + 0.005),
        payerNetwork: ctx.payerNetwork,
      })
    },

    notPlacedReply: (offer) => airtimeOffReply(offer.network),
    readOrder: (db, orderId) => orderRowFor(db, "airtime_orders", orderId),
    classify: classifyStatusOrder,

    statusOf(link, row) {
      if (!row) return link.state === "paid" ? "processing" : link.state === "closed" ? "failed" : "awaiting_payment"
      switch (classifyStatusOrder(row)) {
        case "delivered":
          return "delivered"
        case "paid":
        case "delivery_failed":
          return "processing"
        case "payment_failed":
        case "refunded":
          return "failed"
        default:
          return link.state === "closed" ? "failed" : "awaiting_payment"
      }
    },

    notices: {
      unpaid: unpaidReply,
      delivered: (l) => (l.gift ? airtimeGiftDeliveredReply(l.size, l.recipient) : null),
      paidNotDelivered: delayedReply,
    },
  }
}
