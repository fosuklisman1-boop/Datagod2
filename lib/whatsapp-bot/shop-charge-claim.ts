import { Redis } from "@upstash/redis"

// One shop-bot charge at a time per sender. The session stays on the confirm step while the charge is awaited (the relay
// alone can take 15 s), so a second "1" would otherwise read that step and mint a second order and a second prompt. The
// claim is taken before the order is written, on every gateway.
//
// The TTL outlives the webhook's whole budget (maxDuration 60 s, the charge runs inside it), so a claim can't expire
// under the request holding it, and a plain DEL on release can't free someone else's. A request killed mid-charge leaves
// the claim to expire by itself.
// Keep above maxDuration in app/api/whatsapp/webhook/route.ts; shop-charge-claim.test.ts fails otherwise.
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

/** Each bot has its own claim, so the same customer on both numbers isn't blocked across them. */
export type ChargeScope = "shop" | "main"
const claimKey = (sender: string, scope: ChargeScope) => `wa-${scope}:charge-claim:${sender}`

// Redis not configured at all (local runs, tests): the shop sessions are in-process then too (shop-session.ts), so an
// in-process claim gives the same reach.
const localClaims = new Map<string, number>()

/**
 * - `claimed`: this request may write the order and charge. It must call releaseShopCharge when done.
 * - `held`: another request for this sender is charging. Create nothing.
 * - `unavailable`: Redis is configured but can't answer, so a concurrent charge can't be ruled out. The shop bot creates
 *   Both bots go ahead without a claim, so nothing is released (main bot: owner decision 2026-11-05; shop bot: 2026-11-08).
 */
export type ShopChargeClaim = "claimed" | "held" | "unavailable"

/** At most one outage alert per this long, across instances (admin_settings stamp; see sendThrottledAlert). */
const OUTAGE_ALERT_WINDOW_MS = 30 * 60_000

/** Payments on both bots continue without double-order protection while this lasts, so admins hear about it. No sender number. Never throws. */
async function alertOutage(): Promise<void> {
  try {
    const [{ sendThrottledAlert }, { supabaseAdmin }] = await Promise.all([
      import("@/lib/hubtel-pay/alert-throttle"),
      import("@/lib/supabase"),
    ])
    await sendThrottledAlert(supabaseAdmin, "WhatsApp bots: the payment lock (Redis) is not answering. Both bots' payments continue without double-order protection. Check Upstash.", {
      key: "last_wa_shop_claim_outage_alert", type: "whatsapp_shop_claim_outage", description: "WhatsApp shop charge-claim outage alert throttle",
      windowMs: OUTAGE_ALERT_WINDOW_MS, logPrefix: "[WA-SHOP-CLAIM]",
    })
  } catch (e) {
    console.error("[WA-SHOP-CLAIM] outage alert failed:", e instanceof Error ? e.message : "unknown error")
  }
}

let warnedUnconfigured = false

export async function claimShopCharge(sender: string, scope: ChargeScope = "shop"): Promise<ShopChargeClaim> {
  if (configured) {
    if (!redis) {
      await alertOutage()
      return "unavailable"
    }
    try {
      const result = await redis.set(claimKey(sender, scope), "1", { nx: true, ex: CLAIM_TTL_SECONDS })
      return result === "OK" ? "claimed" : "held"
    } catch (e) {
      console.error("[WA-SHOP-CLAIM] claim failed; going ahead without a claim:", e instanceof Error ? e.message : "unknown error")
      await alertOutage()
      return "unavailable"
    }
  }
  if (!warnedUnconfigured) {
    warnedUnconfigured = true
    console.warn("[WA-SHOP-CLAIM] Redis is not configured: the charge claim is per instance only, so two instances could both charge one sender.")
  }
  const now = Date.now()
  const local = `${scope}:${sender}`
  if ((localClaims.get(local) ?? 0) > now) return "held"
  localClaims.set(local, now + CLAIM_TTL_SECONDS * 1000)
  return "claimed"
}

/** Never throws. If the delete fails the claim expires by itself within CLAIM_TTL_SECONDS. */
export async function releaseShopCharge(sender: string, scope: ChargeScope = "shop"): Promise<void> {
  if (!configured) {
    localClaims.delete(`${scope}:${sender}`)
    return
  }
  try {
    await redis?.del(claimKey(sender, scope))
  } catch (e) {
    console.error("[WA-SHOP-CLAIM] release failed; the claim will expire:", e instanceof Error ? e.message : "unknown error")
  }
}
