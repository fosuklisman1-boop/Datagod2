import { fail, type CommissionTable, type Fail } from "@/lib/storefront-commission/shop"
import type { ResolvedBotContext } from "./context"

/**
 * Abuse caps for the bots (WhatsApp bots are open to anyone). Injected so the engine stays pure; the runtime wires
 * them to the same atomic limiter (applyRateLimit) and pending-count reads the storefront caps use.
 */
export interface BotCapDeps {
  /** Atomic sliding-window limiter keyed by `id` (fails open when the limiter is unavailable). */
  limit(name: string, max: number, windowMs: number, id: string): Promise<boolean>
  /** Count of channel 'bots' rows still pending + unpaid with `column = value` created since `sinceIso`. Errors => 0. */
  countPending(table: CommissionTable, column: "buyer_phone" | "shop_id", value: string, sinceIso: string): Promise<number>
  now(): number
}

export const TOO_MANY_REQUESTS = "Too many requests. Please try again later."
const tooMany = (): Fail => fail(429, TOO_MANY_REQUESTS)

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

export const BOT_VERIFY_CAPS = { phone: { max: 20, windowMs: 10 * MINUTE }, surface: { max: 300, windowMs: HOUR }, global: { max: 2000, windowMs: HOUR } }
export const BOT_PENDING_CAPS = { phone: { max: 5, windowMs: HOUR }, shop: { max: 60, windowMs: HOUR } }

/**
 * Account-lookup caps (run after input validation, before the Hubtel query): per buyer phone 20 / 10 min,
 * per bot surface + shop 300 / h, all bots 2000 / h.
 */
export async function checkBotVerifyCaps(d: BotCapDeps, c: ResolvedBotContext): Promise<Fail | null> {
  const { phone, surface, global } = BOT_VERIFY_CAPS
  const [p, s, g] = await Promise.all([
    d.limit("bot_bill_verify_phone", phone.max, phone.windowMs, `p:${c.buyerPhone}`),
    d.limit("bot_bill_verify_surface", surface.max, surface.windowMs, `s:${c.botSurface}:${c.shopId ?? "main"}`),
    d.limit("bot_bill_verify_all", global.max, global.windowMs, "all"),
  ])
  return p && s && g ? null : tooMany()
}

/**
 * Pending-unpaid order caps, mirroring the storefront: per buyer phone 5 / h and, for shop bots, per shop 60 / h —
 * the atomic limiter first (closes the count→insert race), the DB counts as the backup when the limiter is down.
 * Run after the price check (a 409 never consumes a slot) and right before the single write.
 */
export async function checkBotPendingCaps(
  d: BotCapDeps, kind: "bill" | "bundle", table: CommissionTable, c: ResolvedBotContext,
): Promise<Fail | null> {
  const { phone, shop } = BOT_PENDING_CAPS
  const [p, s] = await Promise.all([
    d.limit(`bot_${kind}_cap_phone`, phone.max, phone.windowMs, `p:${c.buyerPhone}`),
    c.shopId !== null ? d.limit(`bot_${kind}_cap_shop_1h`, shop.max, shop.windowMs, `s:${c.shopId}`) : Promise.resolve(true),
  ])
  if (!p || !s) return tooMany()

  const since = new Date(d.now() - HOUR).toISOString()
  const [byPhone, byShop] = await Promise.all([
    d.countPending(table, "buyer_phone", c.buyerPhone, since),
    c.shopId !== null ? d.countPending(table, "shop_id", c.shopId, since) : Promise.resolve(0),
  ])
  if (byPhone >= phone.max || byShop >= shop.max) return tooMany()
  return null
}
