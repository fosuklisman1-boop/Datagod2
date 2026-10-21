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
export interface BotOtpPointer { reference: string; orderType: BotOrderType; orderId: string; createdAt: string }
/**
 * A pointer as stored / read back: `phone` is the local number it lives under (so it can clear itself). Obtain it
 * only through `peekBotOtpPointer(sessionPhone)` with the network-authenticated MSISDN (USSD) or the WhatsApp sender:
 * that lookup is the auth. One key space for both channels: the same number is the same buyer.
 */
export interface StoredBotOtpPointer extends BotOtpPointer { phone: string }

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

function isPointer(v: unknown): v is StoredBotOtpPointer {
  const p = v as StoredBotOtpPointer | null
  return !!p && typeof p === "object" && typeof p.reference === "string" && typeof p.orderId === "string"
    && (p.orderType === "cs_bill" || p.orderType === "cs_bundle") && typeof p.createdAt === "string" && typeof p.phone === "string"
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
      const key = botOtpPointerKey(phone)
      if (!key) return
      const value: StoredBotOtpPointer = {
        reference: p.reference, orderType: p.orderType, orderId: p.orderId, createdAt: p.createdAt, phone: normalizeGhanaPhone(phone)!,
      }
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
    async peek(phone: string): Promise<StoredBotOtpPointer | null> {
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

/** Store the pending-OTP pointer for this session phone (dialler / WhatsApp sender; TTL 10 min). */
export async function setBotOtpPointer(phone: string, p: BotOtpPointer): Promise<void> {
  return store.set(phone, p)
}

/** The pending-OTP pointer for this session phone (dialler / WhatsApp sender), if any (not consumed). */
export async function peekBotOtpPointer(phone: string): Promise<StoredBotOtpPointer | null> {
  return store.peek(phone)
}

export async function clearBotOtpPointer(phone: string): Promise<void> {
  return store.clear(phone)
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
    try { await d.otpPointer.clear(p.phone) } catch { /* expires on its own */ }
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
