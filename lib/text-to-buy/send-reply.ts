import type { SupabaseClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import { calculateSegments } from "@/lib/sms/segments"
import { storeOutbound } from "./store"
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
 * Three outcomes:
 *  - refused (blank, non-GSM-7 or over one segment): nothing is sent and nothing is stored. { sent: false }
 *  - skipped (sendSMS was a no-op because SMS is switched off globally): nothing was attempted, so no out row is
 *    stored (the admin log and the per-sender reply counters count out rows). { sent: false, skipped: true }
 *  - attempted: the out row is stored either way; sent is true on success and false on a failed or thrown send
 *    (a stored row with sent: false means attempted, not delivered).
 */
export async function sendReply(
  db: SupabaseClient,
  r: { line: Line; sender: string; body: string; settings: TtbSettings; orderLinkId?: string },
  deps: ReplyDeps = {},
): Promise<{ sent: boolean; skipped?: boolean }> {
  const send = deps.send ?? sendSMS

  if (typeof r.body !== "string" || r.body.trim() === "") return { sent: false }
  const seg = calculateSegments(r.body)
  if (seg.encoding !== "gsm7" || seg.segments !== 1) return { sent: false }

  let sent = false
  try {
    const res = await send({
      phone: r.sender,
      message: r.body,
      type: "text_to_buy_reply",
      senderId: (r.line === "shop" ? r.settings.shopReplySenderId : r.settings.replySenderId) || undefined,
      skipLogging: true,
    })
    if (res?.skipped) return { sent: false, skipped: true }
    sent = res?.success === true
  } catch {
    sent = false
  }

  try {
    await storeOutbound(db, { line: r.line, sender: r.sender, body: r.body, orderLinkId: r.orderLinkId })
  } catch {
    // Logging must never break the lane; the store never echoes row values.
  }
  return { sent }
}
