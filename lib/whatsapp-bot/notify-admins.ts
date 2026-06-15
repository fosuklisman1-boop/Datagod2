// lib/whatsapp-bot/notify-admins.ts
//
// Push-notifies admins about inbound WhatsApp messages that warrant attention.
// Three triggers (priority order): a customer replying during an active
// takeover (→ the handling admin), a customer asking for a human (→ all
// admins), and a brand-new conversation (→ all admins). Throttled per
// conversation so a burst of messages can't spam everyone. Best-effort: never
// throws, so it can't break message processing.
import { Redis } from "@upstash/redis"
import { createClient } from "@supabase/supabase-js"
import { notifyAdminsPush, sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
} catch { /* no redis → no throttle, still functions */ }

const THROTTLE_SECONDS = 120
const INBOX_URL = "/admin/whatsapp"

// "talk to a human", "speak to an agent", "customer service", "real person", etc.
const HUMAN_REQUEST_RE =
  /\b(human|agent|representative|rep)\b|(speak|talk|chat)\s+(to|with)\s+(a\s+)?(person|someone|human|agent)|customer\s+(care|service)|real\s+person/i

/** True if the message reads as a request to talk to a person. */
export function isHumanRequest(text: string): boolean {
  return HUMAN_REQUEST_RE.test(text)
}

// Best-effort display name for the push title; falls back to the phone number.
// Only called after the throttle slot is claimed (i.e. rarely), so the extra
// lookups don't touch the hot path.
async function resolveName(phone: string): Promise<string> {
  const { data: convo } = await supabase
    .from("whatsapp_conversations")
    .select("user_id")
    .eq("phone_number", phone)
    .maybeSingle()
  if (!convo?.user_id) return phone
  const { data: u } = await supabase
    .from("users")
    .select("first_name, last_name")
    .eq("id", convo.user_id)
    .maybeSingle()
  const name = u ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() : ""
  return name || phone
}

export async function maybeNotifyAdmins(opts: {
  phone: string
  text: string
  takeoverActive: boolean
  takenOverBy: string | null
  isNewConversation: boolean
  humanRequest: boolean
}): Promise<void> {
  const { phone, text, takeoverActive, takenOverBy, isNewConversation, humanRequest } = opts
  try {
    // Decide the trigger (priority order). No trigger → nothing to do.
    let scope: "owner" | "all" | null = null
    let titlePrefix = ""
    if (takeoverActive && takenOverBy) {
      scope = "owner"; titlePrefix = "New reply from"
    } else if (humanRequest) {
      scope = "all"; titlePrefix = "Wants a human:"
    } else if (isNewConversation) {
      scope = "all"; titlePrefix = "New WhatsApp chat from"
    }
    if (!scope) return

    // Throttle per conversation: claim the slot atomically; bail if already held.
    if (redis) {
      const claimed = await redis.set(`wa:notified:${phone}`, "1", { nx: true, ex: THROTTLE_SECONDS })
      if (claimed === null) return
    }

    const who = await resolveName(phone)
    const payload = {
      title: `${titlePrefix} ${who}`,
      body: text.slice(0, 140),
      data: { url: INBOX_URL },
    }

    if (scope === "owner" && takenOverBy) {
      await sendPushToUser(takenOverBy, payload)
    } else {
      await notifyAdminsPush(payload)
    }
  } catch (e) {
    console.warn("[WA-NOTIFY] maybeNotifyAdmins failed (non-fatal):", e)
  }
}
