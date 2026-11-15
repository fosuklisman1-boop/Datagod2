import type { SupabaseClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import { calculateSegments } from "@/lib/sms/segments"
import { storeOutbound } from "./store"
import { createReplySend } from "./phone-sms/router"
import { chargeSingleReply, drawReserve, refundSingleReply, singleReplyRef, undrawReserve } from "./shop/credits"
import type { TtbSettings } from "./settings"
import type { Line } from "./types"

/**
 * The single function every Text-to-Buy reply goes through. Server-only.
 * One SMS segment, GSM-7 only, never blank: enforced here (the last line of defence behind the reply templates).
 * skipLogging keeps the body out of sms_logs: it lives in ttb_messages under the 30-day retention.
 * Never logs the body or the phone number, and never throws.
 */

export type ReplyDeps = { send?: typeof sendSMS }

/**
 * Who pays for the reply. Default { kind: "datagod" }: nothing is charged. { kind: "shop" }: one credit of the shop owner's
 * SMS account, drawn from the order's reserve when messageId has one, else debited singly under ttb:reply:<replyKey>.
 * replyKey must be unique per reply (letters, digits, "_", "-"; e.g. the inbound message id plus a counter).
 */
export type Payer =
  | { kind: "datagod" }
  | { kind: "shop"; shopId: string; accountId: string; messageId: string | null; replyKey: string }

/**
 * Three outcomes:
 *  - refused (blank, non-GSM-7 or over one segment): nothing is sent and nothing is stored. { sent: false }
 *  - skipped (sendSMS was a no-op because SMS is switched off globally): nothing was attempted, so no out row is
 *    stored (the admin log and the per-sender reply counters count out rows). { sent: false, skipped: true }
 *  - attempted: the out row is stored either way; sent is true on success and false on a failed or thrown send
 *    (a stored row with sent: false means attempted, not delivered).
 */
export async function sendReply(
  db: SupabaseClient,
  r: { line: Line; sender: string; body: string; settings: TtbSettings; orderLinkId?: string; payer?: Payer },
  deps: ReplyDeps = {},
): Promise<{ sent: boolean; skipped?: boolean | "unpaid" }> {
  // Default: the per-line reply transport router (Hubtel unless an admin switched this line to the phone SIM).
  const send = deps.send ?? createReplySend({ db, line: r.line, settings: r.settings })

  if (typeof r.body !== "string" || r.body.trim() === "") return { sent: false }
  const seg = calculateSegments(r.body)
  if (seg.encoding !== "gsm7" || seg.segments !== 1) return { sent: false }

  // Shop payer: the shop's credit is taken BEFORE the send and the reply goes out only if that worked. There is no fallback to
  // Datagod paying here (a Datagod-paid notice is an explicit { kind: "datagod" } call by its caller).
  const shop = r.payer && r.payer.kind === "shop" ? r.payer : null
  let paid: { via: "reserve" } | { via: "single"; accountId: string; ref: string } | null = null
  // drawReserve answers false (never throws) on a transient error, which falls through to a single debit; the reserve's unused
  // credits come back at the order's release. A crash between debit and send is accepted: a retry of the same replyKey finds the
  // ref already debited, reads unpaid and does NOT resend (no double charge, no double send).
  if (shop) {
    try {
      if (shop.messageId && (await drawReserve(db, shop.messageId, 1))) {
        paid = { via: "reserve" }
      } else {
        const ref = singleReplyRef(shop.replyKey)
        if (ref && (await chargeSingleReply(db, { accountId: shop.accountId, credits: 1, ref }))) {
          paid = { via: "single", accountId: shop.accountId, ref }
        }
      }
    } catch {
      paid = null
    }
    if (!paid) return { sent: false, skipped: "unpaid" }
  }

  // Gives back what THIS reply took: a single debit is refunded under the very ref it was debited with; a reserve draw is
  // undrawn (credit back into the order's reserve, returned to the shop at release). A failure never throws; it logs ONE fixed
  // line (no phone, text or ids). An undraw that returns false means the reserve was already released: nothing safe to refund.
  const giveBack = async (): Promise<boolean> => {
    if (!paid) return false
    let ok = false
    try {
      ok =
        paid.via === "single"
          ? await refundSingleReply(db, { accountId: paid.accountId, credits: 1, ref: paid.ref })
          : await undrawReserve(db, shop!.messageId as string, 1)
    } catch {
      ok = false
    }
    if (!ok) console.error("text-to-buy: a shop credit could not be given back for an undelivered reply")
    return ok
  }

  let sent = false
  let refused = false
  try {
    const res = await send({
      phone: r.sender,
      message: r.body,
      type: "text_to_buy_reply",
      senderId: (r.line === "shop" ? r.settings.shopReplySenderId : r.settings.replySenderId) || undefined,
      skipLogging: true,
    })
    if (res?.skipped) {
      await giveBack()
      return { sent: false, skipped: true }
    }
    sent = res?.success === true
    // A definite refusal: the whole provider chain answered and said no. (A throw or timeout below is ambiguous = counts as sent.)
    refused = !sent
  } catch {
    sent = false
  }

  let credits: number | undefined
  if (shop) {
    credits = 1
    if (refused && (await giveBack())) credits = 0 // nothing was kept for this reply: it must not count toward the shop's hourly cap
  }

  try {
    const row: Parameters<typeof storeOutbound>[1] = { line: r.line, sender: r.sender, body: r.body, orderLinkId: r.orderLinkId }
    if (shop) {
      row.shopId = shop.shopId
      row.credits = credits
    }
    await storeOutbound(db, row)
  } catch {
    // Logging must never break the lane; the store never echoes row values.
  }
  return { sent }
}
