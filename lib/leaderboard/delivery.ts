// Prize delivery. The leaderboard_delivery_* RPCs (migration 0137) own the
// state and the locking; this module runs the actual send for each prize type
// against injected dependencies, so it is testable without a database.
//
//   wallet_topup  credit_wallet_safely, reference LB-<result id> (never pays twice)
//   role_upgrade  leaderboard_grant_dealer_days (extends or creates a dealer subscription)
//   data_bundle   GH₵0 `orders` row -> the admin manual-fulfilment path (MTN and non-MTN)
//   airtime       GH₵0 `airtime_orders` row -> the configured airtime provider
//   manual        never sent here: the admin marks it delivered by hand
//
// Data and airtime end in status "sent": the order then completes like any
// other order, and the delivery reads as delivered once it has.

import { normalizeGhanaPhone } from "../phone-format"
import { formatCedis } from "./public"

export type DeliveryStatus = "in_progress" | "sent" | "delivered" | "failed"

export interface StartedDelivery {
  delivery: { id: string; status: DeliveryStatus; order_table: string | null; order_id: string | null; recipient_phone: string | null; attempts: number }
  prize: { id: string; prize_type: string; label: string; amount: number | null; package_id: string | null; network: string | null; duration_days: number | null }
  result: { id: string; board: string; rank: number; user_id: string }
}

export interface FinishInput {
  error?: string
  orderTable?: "orders" | "airtime_orders"
  orderId?: string
  phone?: string
  note?: string
}

export interface DeliveryDeps {
  start(resultId: string): Promise<StartedDelivery>
  finish(deliveryId: string, status: DeliveryStatus, input?: FinishInput): Promise<void>
  creditWallet(userId: string, amount: number, reference: string, description: string): Promise<void>
  grantDealerDays(userId: string, days: number, reference: string): Promise<{ action: string; end_date: string }>
  getPackage(id: string): Promise<{ id: string; network: string; size: string } | null>
  createDataOrder(input: { userId: string; packageId: string; network: string; size: string; phone: string; reference: string }): Promise<string>
  fulfilDataOrder(orderId: string): Promise<{ success: boolean; message: string }>
  createAirtimeOrder(input: { userId: string; network: string; amount: number; phone: string; reference: string }): Promise<{ id: string; reference_code: string; network: string; beneficiary_phone: string; airtime_amount: number }>
  fulfilAirtimeOrder(order: { id: string; reference_code: string; network: string; beneficiary_phone: string; airtime_amount: number }): Promise<boolean>
  notifyWinner(userId: string, title: string, message: string): Promise<void>
}

export type DeliveryOutcome =
  | { ok: true; status: "sent" | "delivered"; message: string }
  | { ok: false; status: "failed"; message: string }

export function deliveryReference(resultId: string): string {
  return `LB-${resultId}`
}

/** Error raised for a reason the admin should read as-is. */
export class DeliveryError extends Error {}

/**
 * Sends one winner's prize. `phone` is the recipient for data and airtime (the
 * admin can change it; it defaults to the winner's number). A delivery that was
 * started is always finished, as sent, delivered or failed, so it never sticks
 * in progress.
 */
export async function deliverPrize(
  deps: DeliveryDeps,
  input: { resultId: string; phone?: string | null; periodLabel: string },
): Promise<DeliveryOutcome> {
  const started = await deps.start(input.resultId)
  const { delivery, prize, result } = started
  const reference = deliveryReference(result.id)

  try {
    switch (prize.prize_type) {
      case "wallet_topup": {
        const amount = Number(prize.amount)
        if (!(amount > 0)) throw new DeliveryError("This prize has no cash amount")
        await deps.creditWallet(result.user_id, amount, reference, `Top Performers prize: ${prize.label} (${input.periodLabel})`)
        await deps.finish(delivery.id, "delivered")
        await notify(deps, result.user_id, "Your prize has arrived!", `${formatCedis(amount)} has been added to your wallet for your Top Performers win (${input.periodLabel}).`)
        return { ok: true, status: "delivered", message: `${formatCedis(amount)} added to the winner's wallet` }
      }

      case "role_upgrade": {
        const days = Number(prize.duration_days)
        let granted: { action: string; end_date: string }
        try {
          granted = await deps.grantDealerDays(result.user_id, days, reference)
        } catch (e) {
          if (errorText(e) === "not_upgradable") {
            throw new DeliveryError("This winner is already a permanent dealer, a sub-agent or an admin, so the upgrade can't be applied. Give them something else and mark this delivered by hand.")
          }
          throw e
        }
        await deps.finish(delivery.id, "delivered")
        const until = new Date(granted.end_date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Accra" })
        await notify(deps, result.user_id, "Your prize has arrived!", `You are a dealer until ${until} — your Top Performers prize for ${input.periodLabel}. Enjoy dealer prices!`)
        return { ok: true, status: "delivered", message: `Winner is a dealer until ${until}` }
      }

      case "data_bundle":
      case "airtime": {
        const phone = normalizeGhanaPhone(input.phone ?? delivery.recipient_phone ?? "")
        if (!phone) throw new DeliveryError("Enter a valid Ghana phone number for this prize")

        let orderId = delivery.order_id
        let label: string
        if (prize.prize_type === "data_bundle") {
          const pkg = prize.package_id ? await deps.getPackage(prize.package_id) : null
          if (!pkg) throw new DeliveryError("This prize's data bundle no longer exists")
          label = prize.label
          if (!orderId) {
            orderId = await deps.createDataOrder({ userId: result.user_id, packageId: pkg.id, network: pkg.network, size: pkg.size, phone, reference })
            // Record the order before sending, so a retry reuses it instead of creating another.
            await deps.finish(delivery.id, "in_progress", { orderTable: "orders", orderId, phone })
          }
          const sent = await deps.fulfilDataOrder(orderId)
          if (!sent.success) throw new DeliveryError(`The data order was created but could not be sent: ${sent.message}`)
        } else {
          const amount = Number(prize.amount)
          if (!(amount > 0) || !prize.network) throw new DeliveryError("This airtime prize is missing its amount or network")
          label = `${formatCedis(amount)} ${prize.network} airtime`
          if (!orderId) {
            const order = await deps.createAirtimeOrder({ userId: result.user_id, network: prize.network, amount, phone, reference })
            orderId = order.id
            await deps.finish(delivery.id, "in_progress", { orderTable: "airtime_orders", orderId, phone })
            // false = handed to admins for a manual send; the order still completes normally.
            await deps.fulfilAirtimeOrder(order)
          }
        }

        await deps.finish(delivery.id, "sent", { orderTable: prize.prize_type === "data_bundle" ? "orders" : "airtime_orders", orderId, phone })
        await notify(deps, result.user_id, "Your prize is on its way!", `${label} is being sent to ${phone} — your Top Performers prize for ${input.periodLabel}.`)
        return { ok: true, status: "sent", message: `Order created and sent for ${phone}. It completes like any other order.` }
      }

      case "manual":
        throw new DeliveryError("Manual prizes are not sent automatically. Use “Mark delivered” once you have given it.")

      default:
        throw new DeliveryError(`Unknown prize type ${prize.prize_type}`)
    }
  } catch (e) {
    const message = e instanceof DeliveryError ? e.message : "Delivery failed. Check the logs, then try again."
    if (!(e instanceof DeliveryError)) console.error("[leaderboard-delivery] failed:", e)
    await deps.finish(delivery.id, "failed", { error: message }).catch((err) => console.error("[leaderboard-delivery] could not record failure:", err))
    return { ok: false, status: "failed", message }
  }
}

function errorText(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? ""
}

async function notify(deps: DeliveryDeps, userId: string, title: string, message: string) {
  // The prize is already delivered; a notification failure must not undo that.
  await deps.notifyWinner(userId, title, message).catch((e) => console.warn("[leaderboard-delivery] notification failed:", e))
}

/** A data/airtime delivery reads as delivered once its order has completed, and as failed if the order failed. */
export function effectiveDeliveryStatus(status: DeliveryStatus | null, orderStatus: string | null): DeliveryStatus | "not_started" {
  if (!status) return "not_started"
  if (status === "sent" && orderStatus === "completed") return "delivered"
  if (status === "sent" && (orderStatus === "failed" || orderStatus === "refunded" || orderStatus === "cancelled")) return "failed"
  return status
}
