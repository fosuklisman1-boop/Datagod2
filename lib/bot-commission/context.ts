import { BOT_RAILS, type BotRail, type CashbackConfig, type CashbackGroup } from "@/lib/cashback/config"
import { ghanaSignificant } from "@/lib/phone-format"
import type { BillerKey } from "@/lib/bills/billers"
import { fail, type Fail } from "@/lib/storefront-commission/shop"

/** The five bots, as stored in `bot_surface` (migration 0123). */
export const BOT_SURFACES = ["hubtel_ussd", "ussd", "ussd_shop", "whatsapp", "whatsapp_shop"] as const
export type BotSurface = (typeof BOT_SURFACES)[number]
export const isBotSurface = (v: unknown): v is BotSurface => typeof v === "string" && (BOT_SURFACES as readonly string[]).includes(v)

/** USSD bots: no Ghana Water (it needs an email and a session the menus cannot carry). */
export const USSD_BOT_SURFACES: readonly BotSurface[] = ["hubtel_ussd", "ussd", "ussd_shop"]

/**
 * Who is buying, through which bot. `shopId` = a shop bot (shop share applies); absent = the main bot.
 * `buyerPhone` = the dialing / WhatsApp number (any Ghana format; stored in 233 form). Built server-side by the bot.
 */
export interface BotContext { botSurface: BotSurface; shopId?: string | null; rail: BotRail; buyerPhone: string }
export interface ResolvedBotContext { botSurface: BotSurface; shopId: string | null; rail: BotRail; buyerPhone: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Shop-only bots must carry a shop; main-only bots must not. hubtel_ussd serves both menus. */
const SHOP_ONLY: readonly BotSurface[] = ["ussd_shop", "whatsapp_shop"]
const MAIN_ONLY: readonly BotSurface[] = ["ussd", "whatsapp"]

/** Validate a bot context: known surface + rail, shop presence matching the surface, buyer phone => 233 form. */
export function resolveBotContext(ctx: BotContext): { ok: true; ctx: ResolvedBotContext } | Fail {
  if (!ctx || !isBotSurface(ctx.botSurface)) return fail(400, "Invalid request")
  if (!(BOT_RAILS as readonly string[]).includes(ctx.rail)) return fail(400, "Invalid request")
  const shopId = ctx.shopId ?? null
  if (shopId !== null && (typeof shopId !== "string" || !UUID.test(shopId))) return fail(400, "Invalid request")
  if (SHOP_ONLY.includes(ctx.botSurface) && shopId === null) return fail(400, "Invalid request")
  if (MAIN_ONLY.includes(ctx.botSurface) && shopId !== null) return fail(400, "Invalid request")
  const sig = typeof ctx.buyerPhone === "string" ? ghanaSignificant(ctx.buyerPhone) : null
  if (!sig) return fail(400, "Enter a valid Ghana mobile number")
  return { ok: true, ctx: { botSurface: ctx.botSurface, shopId, rail: ctx.rail, buyerPhone: "233" + sig } }
}

/** Verify tokens issued in a bot are bound to that bot (and shop): they cannot create orders anywhere else. */
export const botBinding = (c: { botSurface: BotSurface; shopId?: string | null }): string =>
  "bot:" + c.botSurface + ":" + (c.shopId ?? "main")

/** Bots group switch: master AND bots surface AND the group's "sell on bots" switch. */
export const botGroupOn = (cfg: CashbackConfig, group: CashbackGroup): boolean =>
  cfg.enabled === true && cfg.surfaces?.bots === true && cfg.botGroups?.[group] === true

export const GHANA_WATER_NOT_HERE = "This biller is not available here"

/** Ghana Water is WhatsApp-only; every other biller may be sold from any bot (subject to the gates). */
export const botBillerAllowed = (surface: BotSurface, biller: BillerKey): boolean =>
  !(biller === "ghana_water" && USSD_BOT_SURFACES.includes(surface))
