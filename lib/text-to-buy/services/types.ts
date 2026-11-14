import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderStatus } from "../inbound-steps"
import type { QuoteInput } from "../replies"
import type { TtbSettings } from "../settings"
import type { LastOrder, OrderRow, Pending } from "../store"
import type { OrderRead, OrderTable, Service } from "../types"

/** What the follow-up notifier decides from an order's two status columns. */
export type OrderKind = "waiting" | "payment_failed" | "paid" | "delivered" | "delivery_failed" | "refunded"

export type PayerNetwork = QuoteInput["payerNetwork"]

/** A reason the lane cannot price an order: the reply, whether it asks the customer something, and whether to remember the question. */
export type Refusal = { outcome: "asked" | "unavailable"; reply: string; pending?: Pending; remember: boolean }

export type Amounts = { amountGhs: number; deliversGhs?: number }

/** What the service's confirm step reported. No orderId means no order was written. */
export type PlaceResult = { orderId?: string; amountGhs?: number; deliversGhs?: number }

/** What every service hands the lane after it has priced a text: only these fields are read outside the adapter. */
export interface ServiceOffer {
  service: Service
  /** Stored in ttb_orders.size; the re-textable token used by the unpaid and status replies. */
  size: string
  recipientLocal: string
  gift: boolean
  /** The dry-run quote and the fee-on-top lookup only: the charged amount is fixed when the order row is written. */
  previewGhs: number
  previewDeliversGhs?: number
  paystackProvider: "mtn" | "vod" | "tgo"
  lastOrder: LastOrder
}

export interface ServiceAdapter<O extends ServiceOffer = ServiceOffer> {
  readonly service: Service
  readonly orderTable: OrderTable
  /** The TEXT switch only. Live service switches are re-checked in resolve and again inside the handler. */
  textEnabled(s: TtbSettings): boolean
  resolve(db: SupabaseClient, senderLocal: string, read: OrderRead): Promise<{ ok: true; offer: O } | { ok: false; refusal: Refusal }>
  place(offer: O, messageId: string, senderLocal: string): Promise<PlaceResult>
  quote(offer: O, a: Amounts, ctx: { feeOnTop: boolean; payerNetwork: PayerNetwork }): string
  notPlacedReply(offer: O): string
  readOrder(db: SupabaseClient, orderId: string): Promise<OrderRow | null>
  classify(row: { paymentStatus: string; orderStatus: string }): OrderKind
  statusOf(link: { state: string }, row: OrderRow | null): OrderStatus
  notices: {
    unpaid(size: string): string
    /** Null: this link gets no delivered notice (a data order to the sender's own number). */
    delivered(l: { size: string; recipient: string; gift: boolean }): string | null
    paidNotDelivered(): string
  }
}
