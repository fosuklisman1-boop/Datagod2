// Shared glue for the commission-cashback bot flows on the Uzo menus (main USSD + shop USSD):
// the per-surface context, session store / screen helpers, the engine context, and the
// read-back + MoMo charge tail every bot order ends with (Network Plans, Pay Bills).
import type { BotContext } from "@/lib/bot-commission/context"
import type { BotChargeInput, BotChargeResult } from "@/lib/bot-commission/momo"
import { normalizeGhanaPhone } from "@/lib/phone-format"
import { cont as mainCont, end as mainEnd } from "../menus"
import { setSession as setMainSession } from "../session"
import { handleMain } from "../handlers/main"
import { cont as shopCont, end as shopEnd, shopHeaderName } from "@/lib/ussd-shop/menus"
import { setSession as setShopSession } from "@/lib/ussd-shop/session"
import { handleSelectProduct } from "@/lib/ussd-shop/handlers/shop"
import type { UzoResponse, USSDSession, UzoNpSessionFields } from "../types"
import type { USSDShopSession } from "@/lib/ussd-shop/types"
import { botErrorText } from "./screen"

/** Who is dialling, on which Uzo menu. `shopId` = the shop the shop session resolved (active only); main = null. */
export interface UzoBotCtx {
  surface: "ussd" | "ussd_shop"
  sessionId: string
  dialingPhone: string
  shopId: string | null
  shopName?: string
}

/** The menu session a bot flow runs in (main or shop); the flow only adds its own fields. */
export type UzoBotSession = USSDSession | USSDShopSession

/** Session store, screen wrappers and "back to the menu" of the surface the flow runs on. */
export interface UzoBotIo {
  save(sessionId: string, session: UzoBotSession): Promise<void>
  cont(message: string): UzoResponse
  end(message: string): UzoResponse
  /** Leave the flow: back to the main menu (main) or the shop's product menu (shop). */
  leave(ctx: UzoBotCtx, session: UzoBotSession): Promise<UzoResponse>
}

const NP_FIELDS: (keyof UzoNpSessionFields)[] = [
  "npNetwork", "npCategories", "npCategory", "npPage", "npPlans", "npPlan", "npOtherNumber", "npRecipient",
]

/** The session without any bot-flow fields (what the menu had before the flow started). */
export function withoutBotFields<T extends UzoBotSession>(s: T): T {
  const out = { ...s }
  for (const k of NP_FIELDS) delete out[k]
  return out
}

const mainIo: UzoBotIo = {
  save: (id, s) => setMainSession(id, s as USSDSession),
  cont: mainCont,
  end: mainEnd,
  async leave(ctx, s) {
    const main = s as USSDSession
    const next: USSDSession = { step: "MAIN", dialingPhone: main.dialingPhone ?? ctx.dialingPhone, dataBlocked: main.dataBlocked }
    await setMainSession(ctx.sessionId, next)
    // No digit matches "": handleMain renders the main menu itself (one renderer, same visibility rules).
    return handleMain("", ctx.sessionId, next)
  },
}

const shopIo: UzoBotIo = {
  save: (id, s) => setShopSession(id, s as USSDShopSession),
  cont: shopCont,
  end: shopEnd,
  async leave(ctx, s) {
    const next: USSDShopSession = { ...withoutBotFields(s as USSDShopSession), step: "SELECT_PRODUCT" }
    await setShopSession(ctx.sessionId, next)
    // No digit matches "": handleSelectProduct renders the product menu itself.
    return handleSelectProduct("", ctx.sessionId, next)
  },
}

export function liveUzoBotIo(surface: UzoBotCtx["surface"]): UzoBotIo {
  return surface === "ussd_shop" ? shopIo : mainIo
}

/**
 * Engine context for this dialler: main USSD => no shop; shop USSD => the session's resolved shop, and null
 * (fail closed) when the shop is missing. Rail paystack on both menus; the buyer is always the dialing number.
 */
export function uzoBotContext(ctx: UzoBotCtx): BotContext | null {
  if (ctx.surface === "ussd_shop") {
    if (!ctx.shopId) return null
    return { botSurface: "ussd_shop", shopId: ctx.shopId, rail: "paystack", buyerPhone: ctx.dialingPhone }
  }
  if (ctx.surface !== "ussd") return null
  return { botSurface: "ussd", shopId: null, rail: "paystack", buyerPhone: ctx.dialingPhone }
}

/** Shop screens start with the shop name (printable ASCII, kept short so the screen footer always fits). */
export function uzoShopHeader(ctx: UzoBotCtx): string {
  if (ctx.surface !== "ussd_shop") return ""
  const name = shopHeaderName(ctx.shopName ?? "").slice(0, 24).trim()
  return name ? `${name}\n` : ""
}

/** Printable ASCII only (UCS-2 would halve the screen) on names that come from Hubtel. */
export const ascii = (s: string): string => shopHeaderName(s)

/** "MoMo prompt sent" end text (also for an idempotent replay of the same prompt). */
export function uzoPromptSentText(dialingPhone: string): string {
  const local = normalizeGhanaPhone(dialingPhone) ?? dialingPhone
  return `MoMo prompt sent to ${local}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`
}

export const UZO_BOT_UNAVAILABLE = botErrorText(503)

/** What the read-back + charge tail needs. */
export interface UzoBotPayDeps {
  /** The order's status + payment_status; null when there is no row. Throws on a read error. */
  readOrder(orderId: string): Promise<{ status?: string | null; payment_status?: string | null } | null>
  /** Guarded fail (only a still pending + unpaid channel 'bots' row is touched). Never throws. */
  failOrder(orderId: string): Promise<void>
  charge(input: BotChargeInput): Promise<BotChargeResult>
}

/**
 * After the engine created (or handed back) an order: charge it only while it is still pending + unpaid, by a MoMo
 * prompt to the dialing number. Returns the end text.
 * - Read error / no row: its state is unknown, so it is failed (guarded) and nothing is charged.
 * - Not open (paid / closed): refused, nothing charged; the guarded patch could not touch it anyway.
 * - Charge refusals carry their own buyer text (NO_PROVIDER / RATE_LIMITED already failed the order; CHARGE_FAILED
 *   may leave it open and it is not touched here). A charge call that throws fails the order (guarded).
 */
export async function uzoChargeOrder(
  d: UzoBotPayDeps, ctx: UzoBotCtx, orderType: BotChargeInput["orderType"], orderId: string, logTag: string,
): Promise<string> {
  let row: { status?: string | null; payment_status?: string | null } | null
  try {
    row = await d.readOrder(orderId)
  } catch (e) {
    console.error(`[${logTag}] order read-back failed:`, orderId, e instanceof Error ? e.message : "error")
    await d.failOrder(orderId)
    return UZO_BOT_UNAVAILABLE
  }
  if (!row) {
    console.error(`[${logTag}] order not found on read-back:`, orderId)
    await d.failOrder(orderId)
    return UZO_BOT_UNAVAILABLE
  }
  if (row.status !== "pending" || row.payment_status !== "unpaid") {
    console.error(`[${logTag}] order is not open; refusing to charge:`, orderId, row.status ?? null, row.payment_status ?? null)
    return UZO_BOT_UNAVAILABLE
  }
  let r: BotChargeResult
  try {
    r = await d.charge({ orderType, orderId, botSurface: ctx.surface, shopId: ctx.surface === "ussd_shop" ? ctx.shopId : null, dialingPhone: ctx.dialingPhone })
  } catch (e) {
    console.error(`[${logTag}] charge threw:`, orderId, e instanceof Error ? e.message : "error")
    await d.failOrder(orderId)
    return UZO_BOT_UNAVAILABLE
  }
  if (!r.ok) return r.message
  return uzoPromptSentText(ctx.dialingPhone)
}
