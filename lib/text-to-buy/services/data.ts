import { handleConfirm } from "@/lib/ussd/handlers/bundles"
import { resolveOffer, sessionForOffer, sizeLabel, type Offer } from "../catalogue"
import { dedupeNearest, lastOrderOf, orderStatusOf, productQuestion } from "../inbound-steps"
import { deliveredGiftReply, fitOneSegment, paidNotDeliveredReply, quoteReply, unavailableReply, unpaidReply, wrongNumberReply } from "../replies"
import { orderRowFor } from "../store"
import { classifyOrder } from "./classify"
import type { Refusal, ServiceAdapter, ServiceOffer } from "./types"

/** The data-bundle service of the SMS lane: the Stage 1 behaviour, moved here unchanged. Orders go through the USSD confirm handler. */
export type DataOffer = ServiceOffer & { service: "data"; offer: Offer }

type DataDeps = { resolve?: typeof resolveOffer; confirm?: typeof handleConfirm }

export function dataAdapter(deps: DataDeps = {}): ServiceAdapter<DataOffer> {
  return {
    service: "data",
    orderTable: "ussd_orders",
    // Data stays gated by mainEnabled and the data visibility switch exactly as before: there is no separate text switch for it.
    textEnabled: () => true,

    async resolve(db, senderLocal, read) {
      const res = await (deps.resolve ?? resolveOffer)(db, {
        senderLocal, sizeMb: read.sizeMb, networkHint: read.networkHint, recipient: read.recipient,
      })
      if (res.ok) {
        const o = res.offer
        const offer: DataOffer = {
          service: "data", offer: o, size: o.size, recipientLocal: o.recipientLocal, gift: o.gift, previewGhs: o.price,
          paystackProvider: o.paystackProvider, lastOrder: lastOrderOf(o, read.sizeMb),
        }
        return { ok: true, offer }
      }
      let refusal: Refusal
      switch (res.reason) {
        case "choose_product": {
          const q = productQuestion(res.options, read)
          refusal = { outcome: "asked", reply: q.question, pending: q.pending, remember: true }
          break
        }
        case "need_recipient":
          refusal = { outcome: "asked", reply: fitOneSegment([`Which ${res.networkLabel} number should receive it?`]), remember: true }
          break
        case "bad_recipient":
          refusal = { outcome: "asked", reply: wrongNumberReply(), remember: true }
          break
        case "no_package":
          refusal = { outcome: "unavailable", reply: unavailableReply(res.networkLabel, dedupeNearest(res.nearest)), remember: false }
          break
        default:
          refusal = { outcome: "unavailable", reply: unavailableReply("this network", []), remember: false }
      }
      return { ok: false, refusal }
    },

    async place(offer, messageId, senderLocal) {
      // The session id is opaque on purpose: lib/ussd/session.ts logs it when Redis fails, so it must carry no phone number or text.
      const response = await (deps.confirm ?? handleConfirm)("1", `sms:${messageId}`, sessionForOffer(senderLocal, offer.offer), "sms", { momoOnly: true })
      return { orderId: response.orderId, amountGhs: response.amount }
    },

    quote(offer, a, ctx) {
      // A written amount above the offer price is a Paystack-priced row: it already holds the fee, so "+ MoMo charge" would
      // state it twice. (feeOnTop is resolved before confirm and independently of it.)
      return quoteReply({
        size: sizeLabel(offer.offer.size), networkLabel: offer.offer.networkLabel, recipientLocal: offer.recipientLocal, amountGhs: a.amountGhs,
        feeOnTop: ctx.feeOnTop && !(a.amountGhs > offer.offer.price + 0.005), payerNetwork: ctx.payerNetwork,
      })
    },

    notPlacedReply: (offer) => unavailableReply(offer.offer.networkLabel, []),
    readOrder: (db, orderId) => orderRowFor(db, "ussd_orders", orderId),
    classify: classifyOrder,
    statusOf: (link, row) => orderStatusOf(link, row),
    notices: {
      unpaid: unpaidReply,
      delivered: (l) => (l.gift ? deliveredGiftReply(l.size, l.recipient) : null),
      paidNotDelivered: paidNotDeliveredReply,
    },
  }
}
