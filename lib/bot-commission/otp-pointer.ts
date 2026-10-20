import { normalizeGhanaPhone } from "@/lib/phone-format"
import { getUssdRedis } from "@/lib/ussd/session"
import { failBotCharge } from "./momo-fail"
import type { BotMomoDeps, BotOrderType } from "./momo"

/**
 * A bot MoMo charge that Paystack answered with `send_otp`: the buyer finishes it on redial. Keyed by the dialing
 * phone (normalised local form), so the next dial from that number can ask for the code. `phone` is filled in when
 * the pointer is stored (the key it lives under), so the pointer can clear itself.
 */
export interface BotOtpPointer { reference: string; orderType: BotOrderType; orderId: string; createdAt: string; phone?: string }

export const BOT_OTP_POINTER_TTL_SECONDS = 10 * 60

/** `ussd-bot-otp:<0XXXXXXXXX>`, or null for a phone that is not a Ghana mobile number. */
export function botOtpPointerKey(phone: string): string | null {
  const local = normalizeGhanaPhone(phone)
  return local ? `ussd-bot-otp:${local}` : null
}

/** The subset of the Upstash client the pointer uses. */
interface RedisLike {
  setex(key: string, ttl: number, value: string): Promise<unknown>
  get<T = unknown>(key: string): Promise<T | null>
  del(key: string): Promise<unknown>
}

function isPointer(v: unknown): v is BotOtpPointer {
  const p = v as BotOtpPointer | null
  return !!p && typeof p === "object" && typeof p.reference === "string" && typeof p.orderId === "string"
    && (p.orderType === "cs_bill" || p.orderType === "cs_bundle") && typeof p.createdAt === "string"
}

/**
 * Pointer store on the USSD sessions' Upstash client, with the same in-memory fallback the sessions use when Redis is
 * not configured or errors (single instance only; best effort).
 */
export function createBotOtpPointerStore(getRedis: () => RedisLike | null, now: () => number = Date.now) {
  const memory = new Map<string, { p: BotOtpPointer; expires: number }>()
  const tag = "[USSD-BOT-OTP]"
  return {
    async set(phone: string, p: BotOtpPointer): Promise<void> {
      const key = botOtpPointerKey(phone)
      if (!key) return
      const value: BotOtpPointer = { ...p, phone: normalizeGhanaPhone(phone)! }
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
    async peek(phone: string): Promise<BotOtpPointer | null> {
      const key = botOtpPointerKey(phone)
      if (!key) return null
      const redis = getRedis()
      if (redis) {
        try {
          const raw = await redis.get<unknown>(key)
          const v = typeof raw === "string" ? JSON.parse(raw) : raw
          if (v != null) return isPointer(v) ? v : null
        } catch (e) {
          console.error(tag, "get error:", e instanceof Error ? e.message : String(e))
        }
      }
      const m = memory.get(key)
      if (m && m.expires > now()) return m.p
      if (m) memory.delete(key)
      return null
    },
    async clear(phone: string): Promise<void> {
      const key = botOtpPointerKey(phone)
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

/** Store the pending-OTP pointer for this dialing phone (TTL 10 min). */
export async function setBotOtpPointer(phone: string, p: BotOtpPointer): Promise<void> {
  return store.set(phone, p)
}

/** The pending-OTP pointer for this dialing phone, if any (not consumed). */
export async function peekBotOtpPointer(phone: string): Promise<BotOtpPointer | null> {
  return store.peek(phone)
}

export async function clearBotOtpPointer(phone: string): Promise<void> {
  return store.clear(phone)
}

/**
 * Finish a `send_otp` bot charge with the code the buyer typed on redial. The pointer is cleared whatever happens
 * (one try per pointer). A rejected code (`failed`) marks this payment failed and fails the order with the guarded
 * bot patch (a paid order is never touched). A submit error leaves both alone: the charge may still complete and the
 * webhook confirms it.
 */
export async function submitBotOtp(d: BotMomoDeps, p: BotOtpPointer, otp: string): Promise<{ ok: boolean }> {
  let status: string | null = null
  try {
    status = (await d.submitOtp(p.reference, otp)).status
  } catch (e) {
    console.error("[USSD-BOT-OTP] submit error:", e instanceof Error ? e.message : String(e))
  }
  if (p.phone) {
    try { await d.otpPointer.clear(p.phone) } catch { /* expires on its own */ }
  }
  if (status === null) return { ok: false }
  if (status === "failed") {
    await failBotCharge(d.db, p.orderType, p.orderId, p.reference, "USSD-BOT-OTP")
    return { ok: false }
  }
  return { ok: true }
}
