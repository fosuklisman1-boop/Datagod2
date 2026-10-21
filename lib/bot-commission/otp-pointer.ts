import { normalizeGhanaPhone } from "@/lib/phone-format"
import { getUssdRedis } from "@/lib/ussd/session"
import { failBotCharge } from "./momo-fail"
import type { BotMomoDeps, BotOrderType } from "./momo"

/**
 * A bot MoMo charge that Paystack answered with `send_otp`: the buyer finishes it on redial (USSD) or with the next
 * chat reply (WhatsApp). Keyed by the session's authenticated number (normalised local form): the USSD dialling
 * MSISDN, or the WhatsApp sender. NEVER by the typed paying number (botChargeMomo's `payPhone`), so a pointer can only
 * be reached by the session that owns the order.
 */
export interface BotOtpPointer {
  reference: string; orderType: BotOrderType; orderId: string; createdAt: string
  /**
   * Key space: absent = the Uzo USSD (`ussd-bot-otp:<0X>`, stored exactly as before), "whatsapp" = the WhatsApp bots
   * (`wa-bot-otp:<0X>`). A pointer is only ever found through its own channel.
   */
  channel?: "whatsapp"
}

/** Which bot channel's key space a pointer lives in. */
export type BotOtpChannel = "ussd" | "whatsapp"
/**
 * A pointer as stored / read back: `phone` is the local number it lives under (so it can clear itself). Obtain it
 * only through `peekBotOtpPointer(sessionPhone)` with the network-authenticated MSISDN (USSD) or the WhatsApp sender:
 * that lookup is the auth. Each channel has its own key space, so a WhatsApp pointer never surfaces on a USSD redial
 * (or the reverse).
 */
export interface StoredBotOtpPointer extends BotOtpPointer { phone: string }

export const BOT_OTP_POINTER_TTL_SECONDS = 10 * 60

/**
 * `ussd-bot-otp:<0XXXXXXXXX>` (Uzo, the default) or `wa-bot-otp:<0XXXXXXXXX>` (WhatsApp), or null for a phone that is
 * not a Ghana mobile number.
 */
export function botOtpPointerKey(phone: string, channel: BotOtpChannel = "ussd"): string | null {
  const local = normalizeGhanaPhone(phone)
  if (!local) return null
  return channel === "whatsapp" ? `wa-bot-otp:${local}` : `ussd-bot-otp:${local}`
}

const channelOf = (p: { channel?: unknown }): BotOtpChannel => (p.channel === "whatsapp" ? "whatsapp" : "ussd")

/** The subset of the Upstash client the pointer uses. */
interface RedisLike {
  setex(key: string, ttl: number, value: string): Promise<unknown>
  get<T = unknown>(key: string): Promise<T | null>
  del(key: string): Promise<unknown>
}

function isPointer(v: unknown): v is StoredBotOtpPointer {
  const p = v as StoredBotOtpPointer | null
  return !!p && typeof p === "object" && typeof p.reference === "string" && typeof p.orderId === "string"
    && (p.orderType === "cs_bill" || p.orderType === "cs_bundle") && typeof p.createdAt === "string" && typeof p.phone === "string"
    && (p.channel === undefined || p.channel === "whatsapp")
}

/**
 * Pointer store on the USSD sessions' Upstash client, with the same in-memory fallback the sessions use when Redis is
 * not configured or errors (single instance only; best effort).
 */
export function createBotOtpPointerStore(getRedis: () => RedisLike | null, now: () => number = Date.now) {
  const memory = new Map<string, { p: StoredBotOtpPointer; expires: number }>()
  const tag = "[USSD-BOT-OTP]"
  return {
    async set(phone: string, p: BotOtpPointer): Promise<void> {
      const channel = channelOf(p)
      const key = botOtpPointerKey(phone, channel)
      if (!key) return
      const value: StoredBotOtpPointer = {
        reference: p.reference, orderType: p.orderType, orderId: p.orderId, createdAt: p.createdAt, phone: normalizeGhanaPhone(phone)!,
      }
      if (channel === "whatsapp") value.channel = "whatsapp" // Uzo values are stored exactly as before
      const redis = getRedis()
      if (redis) {
        try {
          await redis.setex(key, BOT_OTP_POINTER_TTL_SECONDS, JSON.stringify(value))
          return
        } catch (e) {
          console.error(tag, "set error:", e instanceof Error ? e.message : String(e))
        }
      }
      memory.set(key, { p: value, expires: now() + BOT_OTP_POINTER_TTL_SECONDS * 1000 })
    },
    async peek(phone: string, channel: BotOtpChannel = "ussd"): Promise<StoredBotOtpPointer | null> {
      const key = botOtpPointerKey(phone, channel)
      if (!key) return null
      const redis = getRedis()
      if (redis) {
        try {
          const raw = await redis.get<unknown>(key)
          const v = typeof raw === "string" ? JSON.parse(raw) : raw
          // A value must belong to the key space it was found in.
          if (v != null) return isPointer(v) && channelOf(v) === channel ? v : null
        } catch (e) {
          console.error(tag, "get error:", e instanceof Error ? e.message : String(e))
        }
      }
      const m = memory.get(key)
      if (m && m.expires > now()) return m.p
      if (m) memory.delete(key)
      return null
    },
    async clear(phone: string, channel: BotOtpChannel = "ussd"): Promise<void> {
      const key = botOtpPointerKey(phone, channel)
      if (!key) return
      const redis = getRedis()
      if (redis) {
        try {
          await redis.del(key)
        } catch (e) {
          console.error(tag, "delete error:", e instanceof Error ? e.message : String(e))
        }
      }
      memory.delete(key)
    },
  }
}

const store = createBotOtpPointerStore(() => getUssdRedis())

/** Store the pending-OTP pointer for this session phone (TTL 10 min), in `p.channel`'s key space (default Uzo). */
export async function setBotOtpPointer(phone: string, p: BotOtpPointer): Promise<void> {
  return store.set(phone, p)
}

/** The pending-OTP pointer for this session phone in this channel (default Uzo), if any (not consumed). */
export async function peekBotOtpPointer(phone: string, channel: BotOtpChannel = "ussd"): Promise<StoredBotOtpPointer | null> {
  return store.peek(phone, channel)
}

export async function clearBotOtpPointer(phone: string, channel: BotOtpChannel = "ussd"): Promise<void> {
  return store.clear(phone, channel)
}

/**
 * - `{ ok: true, retry: false }`: code accepted; the buyer approves the MoMo prompt (show the approve-prompt text).
 * - `{ ok: false, retry: true }`: wrong code (Paystack asks for the OTP again), any other non-final answer, or the
 *   submit call failed. The pointer is kept (until its TTL) so the buyer can redial and try again
 *   ("Wrong code. Try again").
 * - `{ ok: false, retry: false }`: final failure; the payment and the order were failed (guarded).
 */
export type SubmitBotOtpResult = { ok: true; retry: false } | { ok: false; retry: boolean }

/** Paystack answers after a code that mean "accepted, waiting for / done with the approval". */
const OTP_ACCEPTED = new Set(["success", "pending", "pay_offline"])

/**
 * Finish a `send_otp` bot charge with the code the buyer typed on redial. The pointer is cleared only on an accepted
 * code or a final failure. A rejected charge (`failed`) marks this payment failed and fails the order with the guarded
 * bot patch (a paid order is never touched). Anything else leaves the order, the payment and the pointer alone.
 */
export async function submitBotOtp(d: BotMomoDeps, p: StoredBotOtpPointer, otp: string): Promise<SubmitBotOtpResult> {
  let status: string
  try {
    status = (await d.submitOtp(p.reference, otp)).status
  } catch (e) {
    console.error("[USSD-BOT-OTP] submit error:", e instanceof Error ? e.message : String(e))
    return { ok: false, retry: true }
  }
  const clear = async () => {
    if (!p.phone) return
    try {
      // Cleared in its own channel (a Uzo pointer exactly as before).
      if (p.channel === "whatsapp") await d.otpPointer.clear(p.phone, "whatsapp")
      else await d.otpPointer.clear(p.phone)
    } catch { /* expires on its own */ }
  }
  if (OTP_ACCEPTED.has(status)) {
    await clear()
    return { ok: true, retry: false }
  }
  if (status === "failed") {
    await clear()
    await failBotCharge(d.db, p.orderType, p.orderId, p.reference, "USSD-BOT-OTP")
    return { ok: false, retry: false }
  }
  return { ok: false, retry: true }
}
