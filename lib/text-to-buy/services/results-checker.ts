import { calculateRCPrice, getAvailableCount, getMaxQuantity, isExamBoardEnabled, isValidExamBoard } from "@/lib/results-checker-service"
import { ghanaSignificant } from "@/lib/phone-format"
import { buildRcBoardOptions, confirmRcByText } from "@/lib/ussd/handlers/results-checker"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import type { USSDSession } from "@/lib/ussd/types"
import { placedNeutralReply, unpaidReply, delayedReply, voucherBoardQuestion, voucherMaxReply, voucherOffReply, voucherQuoteReply } from "../replies"
import { orderRowFor, type Pending } from "../store"
import type { ExamBoardWord, OrderRead } from "../types"
import { classifyStatusOrder } from "./classify"
import type { Refusal, ServiceAdapter, ServiceOffer } from "./types"

/**
 * The exam checker voucher service of the SMS lane. The customer types a board and a quantity; code prices it (the AI never does)
 * and the confirm step (confirmRcByText) writes the order and starts the MoMo charge. The amount quoted, stored and charged is the
 * one the order row holds.
 *
 * PINs never pass through this lane: after payment the normal voucher fulfilment delivers them to the order's customer_phone.
 * This module imports nothing from the SMS or voucher delivery services on purpose, and its tests read the source to keep it so.
 */
export type VoucherOffer = ServiceOffer & { service: "results_checker"; board: ExamBoardWord; quantity: number }

type VoucherDeps = { confirm?: typeof confirmRcByText; boards?: typeof buildRcBoardOptions }
type VoucherRead = Extract<OrderRead, { service: "results_checker" }>

/** The staged session the confirm step reads: only what it needs. The payer is always the verified sender. */
export function voucherSession(senderLocal: string, o: VoucherOffer): USSDSession {
  return { step: "RC_CONFIRM", dialingPhone: "+233" + ghanaSignificant(senderLocal), rcBoard: o.board, rcQty: o.quantity } as USSDSession
}

const refuse = (outcome: Refusal["outcome"], reply: string, remember = false, pending?: Pending): { ok: false; refusal: Refusal } => ({
  ok: false,
  refusal: { outcome, reply, remember, ...(pending ? { pending } : {}) },
})

function boardChoices(read: VoucherRead, boards: ExamBoardWord[]): Pending {
  return {
    type: "choices",
    options: boards.map((b, k) => ({ label: `${k + 1}) ${b}`, read: { ...read, board: b } satisfies VoucherRead })),
  }
}

export function resultsCheckerAdapter(deps: VoucherDeps = {}): ServiceAdapter<VoucherOffer> {
  return {
    service: "results_checker",
    orderTable: "results_checker_orders",
    textEnabled: (s) => s.resultsCheckerEnabled,

    async resolve(_db, senderLocal, read) {
      // The lane routes by read.service, so this is unreachable; it keeps the type honest and fails closed.
      if (read.kind !== "order" || read.service !== "results_checker") return refuse("unavailable", voucherOffReply(null))
      try {
        const sender = ghanaSignificant(senderLocal)
        if (!sender) return refuse("unavailable", voucherOffReply(null))

        let board = read.board
        if (board === null) {
          const stocked = (await (deps.boards ?? buildRcBoardOptions)()).filter(isValidExamBoard) as ExamBoardWord[]
          if (stocked.length === 0) return refuse("unavailable", voucherOffReply(null))
          if (stocked.length > 1) return refuse("asked", voucherBoardQuestion(stocked), true, boardChoices(read, stocked))
          board = stocked[0]
        }

        const [enabled, available] = await Promise.all([isExamBoardEnabled(board), getAvailableCount(board)])
        if (!enabled || !(available > 0)) return refuse("unavailable", voucherOffReply(board))

        const quantity = read.quantity
        if (!Number.isInteger(quantity) || quantity < 1) return refuse("unavailable", voucherOffReply(board))
        const cap = Math.min(available, await getMaxQuantity())
        if (quantity > cap) return refuse("unavailable", voucherMaxReply(board, cap))

        const total = (await calculateRCPrice({ examBoard: board, quantity, applyBulk: true })).totalPaid
        if (!(Number.isFinite(total) && total > 0)) return refuse("unavailable", voucherOffReply(board))

        const offer: VoucherOffer = {
          service: "results_checker",
          board,
          quantity,
          size: `${quantity} ${board.toLowerCase()}`,
          recipientLocal: "0" + sender,
          gift: false,
          previewGhs: total,
          // Only the fee-on-top lookup reads this; the confirm step refuses a number with no MoMo provider.
          paystackProvider: paystackProviderFromPhone("+233" + sender) ?? "mtn",
          lastOrder: { service: "results_checker", board, quantity },
        }
        return { ok: true, offer }
      } catch (e) {
        console.error("[text-to-buy] voucher resolve error", { error: e instanceof Error ? e.name : "unknown" })
        return refuse("unavailable", voucherOffReply(null))
      }
    },

    async place(offer, messageId, senderLocal) {
      // The session id is opaque on purpose: lib/ussd/session.ts logs it when Redis fails, so it must carry no phone number or text.
      const r = await (deps.confirm ?? confirmRcByText)(`sms:${messageId}`, voucherSession(senderLocal, offer))
      return { orderId: r.orderId, amountGhs: r.amount }
    },

    quote(offer, a, ctx) {
      // Only the placed total is ever stated; without a usable one no money is stated at all.
      if (!Number.isFinite(a.amountGhs)) return placedNeutralReply()
      return voucherQuoteReply({
        board: offer.board,
        quantity: offer.quantity,
        amountGhs: a.amountGhs,
        // A written total above the preview already holds the gateway charge: "+ MoMo charge" would state it twice.
        feeOnTop: ctx.feeOnTop && !(a.amountGhs > offer.previewGhs + 0.005),
        payerNetwork: ctx.payerNetwork,
      })
    },

    notPlacedReply: (offer) => voucherOffReply(offer.board),
    readOrder: (db, orderId) => orderRowFor(db, "results_checker_orders", orderId),
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
      delivered: () => null, // the PINs themselves are the delivery message; a second lane SMS would only duplicate it
      paidNotDelivered: delayedReply,
    },
  }
}
