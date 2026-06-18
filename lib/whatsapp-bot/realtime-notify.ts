// lib/whatsapp-bot/realtime-notify.ts
//
// Pushes a Supabase Realtime broadcast so the admin WhatsApp inbox updates the
// instant a message is logged — instead of waiting for the next poll. Sent over
// the Realtime REST broadcast API (no table publication or RLS needed; the inbox
// subscribes to the same "wa-inbox" channel). Best-effort and fire-and-forget:
// if Realtime is unavailable the inbox's polling fallback still picks the message up.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

export const WA_INBOX_CHANNEL = "wa-inbox"

export function notifyInboxChange(phone: string, direction: "inbound" | "outbound"): void {
  if (!SUPABASE_URL || !SERVICE_KEY) return
  // Don't block the caller (the bot's reply path) on this network call.
  void (async () => {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2500)
      await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{
            topic: WA_INBOX_CHANNEL,
            event: "message",
            private: false,
            payload: { phone, direction },
          }],
        }),
        signal: ctrl.signal,
      })
      clearTimeout(t)
    } catch {
      // best-effort — polling fallback covers it
    }
  })()
}
