import type { SupabaseClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import { calculateSegments } from "@/lib/sms/segments"
import { storeOutbound } from "./store"
import type { TtbSettings } from "./settings"
import type { Line } from "./types"

/**
 * The single function every Text-to-Buy reply goes through. Server-only.
 * One SMS segment, GSM-7 only, enforced here (the last line of defence behind the reply templates).
 * skipLogging keeps the body out of sms_logs: it lives in ttb_messages under the 30-day retention.
 * Never logs the body or the phone number, and never throws.
 */

export type ReplyDeps = { send?: typeof sendSMS }

export async function sendReply(
  db: SupabaseClient,
  r: { line: Line; sender: string; body: string; settings: TtbSettings; orderLinkId?: string },
  deps: ReplyDeps = {},
): Promise<{ sent: boolean }> {
  const send = deps.send ?? sendSMS

  const seg = calculateSegments(r.body)
  if (seg.encoding !== "gsm7" || seg.segments !== 1) return { sent: false }

  let sent = false
  try {
    const res = await send({
      phone: r.sender,
      message: r.body,
      type: "text_to_buy_reply",
      senderId: r.settings.replySenderId || undefined,
      skipLogging: true,
    })
    sent = res?.success === true
  } catch {
    sent = false
  }

  // Recorded either way, so a failed send is visible in the admin log. (The out row has no
  // delivery column, so a failed send is an out row the customer never received.)
  try {
    await storeOutbound(db, { line: r.line, sender: r.sender, body: r.body, orderLinkId: r.orderLinkId })
  } catch {
    // Logging must never break the lane; the store never echoes row values.
  }
  return { sent }
}
