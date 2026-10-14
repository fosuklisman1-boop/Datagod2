// lib/ussd-hubtel/flows/shop.ts
// Shop mode entry (spec 5 "Shop mode"): shop code first, then the shop's product menu. Port of
// lib/ussd-shop/handlers/shop.ts. Entering a shop is free: session tokens were retired
// (docs/superpowers/specs/2026-10-14-ussd-shop-free-sessions-design.md), so an active code is all it takes.
import type { HubtelUssdConfig } from "../config"
import {
  resolveShopMenu, shopCodePromptText, shopCodeRetryText, shopMenuText, sortShopNetworks, type MainMenuKey,
} from "../menus"
import { release, respond, toE164 } from "../protocol"
import { safeDbError } from "../log-safe"
import { finish, goto, say, type FlowCtx, type RouterDeps, type StepTable } from "../flow-kit"
import type { HubtelReply, HubtelRequest, HubtelSession } from "../types"

const CODE = { label: "Shop code", fieldType: "text" as const }
const PRODUCT = { label: "Shop menu" }
/** ussd_shop_codes.code is VARCHAR(8), generated as 4-6 digits. Anything else is not a code. */
const SHOP_CODE_RE = /^[A-Za-z0-9]{1,8}$/

const INVALID = "Invalid code. Try again."
const TOO_MANY = "Too many attempts. Please try again later."
/** Wrong codes allowed per Hubtel session; the third ends the session. */
export const MAX_CODE_ATTEMPTS = 3

export function shopMenuFor(config: HubtelUssdConfig, dataBlocked: boolean) {
  return resolveShopMenu(config.visibility as Record<MainMenuKey, boolean>, dataBlocked)
}

/** The product menu for the session's shop, without writing the session. */
export function shopMenuReply(ctx: FlowCtx, prefix = ""): HubtelReply {
  const s = ctx.session
  return say(ctx, prefix + shopMenuText(s.shopName ?? "Shop", shopMenuFor(ctx.config, s.dataBlocked === true)), "SHOP_PRODUCT", PRODUCT)
}

/** "0" on a shop flow's first screen: back to the product menu, keeping only the shop context. */
export async function backToProduct(ctx: FlowCtx, prefix = ""): Promise<HubtelReply> {
  const s = ctx.session
  const clean: HubtelSession = {
    mode: "shop", step: "SHOP_PRODUCT", dialingPhone: s.dialingPhone, platform: s.platform, dataBlocked: s.dataBlocked,
    shopCodeId: s.shopCodeId, shopId: s.shopId, parentShopId: s.parentShopId, shopName: s.shopName, shopNetworks: s.shopNetworks,
  }
  await ctx.deps.sessions.set(ctx.req.SessionId, clean)
  return shopMenuReply({ ...ctx, session: clean }, prefix)
}

/** Initiation (or a restart) in shop mode: pins mode=shop and asks for the shop code. */
export async function startShopSession(
  req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, prefix: string
): Promise<HubtelReply> {
  const dataBlocked = await deps.isDataBlocked(req.Mobile)
  // Checked BEFORE the code is asked (D4), so the caller is never asked for a code with nothing to buy.
  if (shopMenuFor(config, dataBlocked).length === 0) {
    await deps.sessions.del(req.SessionId)
    return release(req.SessionId, "No services available right now. Please try again later.", { platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, {
    mode: "shop", step: "SHOP_ENTER_CODE", dialingPhone: toE164(req.Mobile), platform: req.Platform, dataBlocked,
  })
  return respond(req.SessionId, prefix + shopCodePromptText(config.welcome), {
    label: CODE.label, fieldType: CODE.fieldType, clientState: "SHOP_ENTER_CODE", platform: req.Platform,
  })
}

/**
 * A shop code typed after the session record was lost (Redis miss / TTL / a Timeout that raced the
 * code). Hubtel echoes the ClientState of our previous reply, so "SHOP_ENTER_CODE" proves the caller
 * was on the code prompt: rebuild the base shop session (nothing else is needed at that step) and
 * process the code instead of restarting with "Session expired". null when the caller has no shop
 * service (the restart then releases).
 */
export async function recoverShopCodeEntry(
  req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig
): Promise<HubtelReply | null> {
  if (config.mode !== "shop" || req.ClientState !== "SHOP_ENTER_CODE") return null
  const dataBlocked = await deps.isDataBlocked(req.Mobile)
  if (shopMenuFor(config, dataBlocked).length === 0) return null
  const session: HubtelSession = {
    mode: "shop", step: "SHOP_ENTER_CODE", dialingPhone: toE164(req.Mobile), platform: req.Platform, dataBlocked,
  }
  await deps.sessions.set(req.SessionId, session)
  return enterCode({ input: req.Message.trim(), req, deps, config, session })
}

async function enterCode(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps } = ctx
  if (input === "0") return finish(ctx, "Goodbye.")
  // A wrong / malformed / inactive code counts toward the per-session cap (no guessing codes in one session).
  const wrongCode = async (): Promise<HubtelReply> => {
    const attempts = (ctx.session.shopCodeAttempts ?? 0) + 1
    if (attempts >= MAX_CODE_ATTEMPTS) return finish(ctx, TOO_MANY)
    return goto(ctx, { step: "SHOP_ENTER_CODE", shopCodeAttempts: attempts }, shopCodeRetryText(INVALID), CODE)
  }
  if (!SHOP_CODE_RE.test(input)) return wrongCode()

  const shop = await deps.shop.resolveCode(input)
  if (!shop || shop.status !== "active") return wrongCode()

  // A shop may sell only airtime / vouchers: an empty network list does not block entry (Uzo).
  // A lookup failure must not fail the request: continue with no networks (the data flow then
  // says there is nothing to buy) and log ids only.
  const rawNetworks = await deps.shop.networks(shop.shopId, shop.parentShopId ?? undefined).catch((e: unknown) => {
    console.error("[HUBTEL-SHOP] networks lookup failed after code acceptance for shop", shop.shopId, safeDbError(e))
    return [] as string[]
  })
  const networks = sortShopNetworks(rawNetworks)
  return goto(ctx, {
    step: "SHOP_PRODUCT",
    shopCodeAttempts: undefined,
    shopCodeId: shop.shopCodeId,
    shopId: shop.shopId,
    parentShopId: shop.parentShopId ?? undefined,
    shopName: shop.shopName,
    shopNetworks: networks,
  }, shopMenuText(shop.shopName, shopMenuFor(ctx.config, ctx.session.dataBlocked === true)), PRODUCT)
}

export const SHOP_ENTRY_STEPS: StepTable = {
  SHOP_ENTER_CODE: enterCode,
}
