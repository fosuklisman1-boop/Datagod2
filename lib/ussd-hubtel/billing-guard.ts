// lib/ussd-hubtel/billing-guard.ts
// Shop-mode token billing guard: at most ONE shop session token per (Hubtel SessionId, shop code).
// The Uzo shop code deducts a token every time a code is accepted and relies only on the session
// moving past the code step to avoid a second deduction. Hubtel can redeliver a request (lost
// reply, retry) and a "Session expired" restart re-asks for the code within the same SessionId,
// so the claim is an explicit Redis SET NX marker, taken BEFORE deduct_ussd_shop_token runs.
import { Redis } from "@upstash/redis"

export type BillingClaim = "claimed" | "already" | "error"

export interface ShopBillingGuard {
  /** "claimed": this call may deduct. "already": this session already paid for this code. "error": guard unavailable, do NOT deduct. */
  claim(sessionId: string, shopCodeId: string): Promise<BillingClaim>
  /** Undo a claim whose deduction did not happen (no balance, RPC false or error). */
  release(sessionId: string, shopCodeId: string): Promise<void>
}

/** Far longer than any Hubtel session; short enough not to pile up keys. */
export const SHOP_BILLING_TTL_SECONDS = 60 * 60

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  }
} catch (e) {
  console.error("[HUBTEL-SHOP-BILLING] Failed to initialise Redis:", e)
}

const memory = new Map<string, number>() // dev only (same env rule as session.ts): key -> expiry ms
const key = (sessionId: string, shopCodeId: string) => `ussd-hubtel:shop-billed:${sessionId}:${shopCodeId}`

export const shopBillingGuard: ShopBillingGuard = {
  async claim(sessionId, shopCodeId) {
    const k = key(sessionId, shopCodeId)
    if (redis) {
      try {
        const res = await redis.set(k, "1", { nx: true, ex: SHOP_BILLING_TTL_SECONDS })
        return res === "OK" ? "claimed" : "already"
      } catch (e) {
        console.error("[HUBTEL-SHOP-BILLING] claim error for", sessionId, ":", e)
        return "error"
      }
    }
    const now = Date.now()
    const exp = memory.get(k)
    if (exp !== undefined && exp > now) return "already"
    memory.set(k, now + SHOP_BILLING_TTL_SECONDS * 1000)
    return "claimed"
  },
  async release(sessionId, shopCodeId) {
    const k = key(sessionId, shopCodeId)
    if (redis) {
      // If this fails the marker stays: this session may re-enter the code once without a
      // deduction (logged). Never deduct to compensate.
      try { await redis.del(k) } catch (e) { console.error("[HUBTEL-SHOP-BILLING] release error for", sessionId, ":", e) }
      return
    }
    memory.delete(k)
  },
}
