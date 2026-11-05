import { Redis } from "@upstash/redis"

// One shop-bot charge at a time per sender. The session stays on the confirm step while the charge is awaited (the relay
// alone can take 15 s), so a second "1" would otherwise read that step and mint a second order and a second prompt. The
// claim is taken before the order is written, on every gateway.
//
// The TTL outlives the webhook's whole budget (maxDuration 60 s, the charge runs inside it), so a claim can't expire
// under the request holding it, and a plain DEL on release can't free someone else's. A request killed mid-charge leaves
// the claim to expire by itself.
const CLAIM_TTL_SECONDS = 75

const configured = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)

let redis: Redis | null = null
try {
  if (configured) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  }
} catch (e) {
  console.error("[WA-SHOP-CLAIM] Failed to initialise Redis:", e instanceof Error ? e.message : "unknown error")
}

const claimKey = (sender: string) => `wa-shop:charge-claim:${sender}`

// Redis not configured at all (local runs, tests): the shop sessions are in-process then too (shop-session.ts), so an
// in-process claim gives the same reach.
const localClaims = new Map<string, number>()

/**
 * - `claimed`: this request may write the order and charge. It must call releaseShopCharge when done.
 * - `held`: another request for this sender is charging. Create nothing.
 * - `unavailable`: Redis is configured but can't answer, so a concurrent charge can't be ruled out. Create nothing.
 */
export type ShopChargeClaim = "claimed" | "held" | "unavailable"

export async function claimShopCharge(sender: string): Promise<ShopChargeClaim> {
  if (configured) {
    if (!redis) return "unavailable"
    try {
      const result = await redis.set(claimKey(sender), "1", { nx: true, ex: CLAIM_TTL_SECONDS })
      return result === "OK" ? "claimed" : "held"
    } catch (e) {
      console.error("[WA-SHOP-CLAIM] claim failed; refusing the charge:", e instanceof Error ? e.message : "unknown error")
      return "unavailable"
    }
  }
  const now = Date.now()
  if ((localClaims.get(sender) ?? 0) > now) return "held"
  localClaims.set(sender, now + CLAIM_TTL_SECONDS * 1000)
  return "claimed"
}

/** Never throws. If the delete fails the claim expires by itself within CLAIM_TTL_SECONDS. */
export async function releaseShopCharge(sender: string): Promise<void> {
  if (!configured) {
    localClaims.delete(sender)
    return
  }
  try {
    await redis?.del(claimKey(sender))
  } catch (e) {
    console.error("[WA-SHOP-CLAIM] release failed; the claim will expire:", e instanceof Error ? e.message : "unknown error")
  }
}
