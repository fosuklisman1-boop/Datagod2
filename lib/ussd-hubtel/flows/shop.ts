// lib/ussd-hubtel/flows/shop.ts
// Shop mode entry (spec 5 "Shop mode"): shop code first, then the shop's product menu. Port of
// lib/ussd-shop/handlers/shop.ts. Billing is Uzo's: one session token is deducted when the code
// is accepted and is never refunded if the caller does not buy. On this channel a Hubtel session
// pays at most once per shop code (deps.shopBilling), so retries and restarts never double-bill.
import type { HubtelUssdConfig } from "../config"
import {
  resolveShopMenu, shopCodePromptText, shopCodeRetryText, shopMenuText, sortShopNetworks, type MainMenuKey,
} from "../menus"
import { release, respond, toE164 } from "../protocol"
import { LOW_TOKEN_ALERT_AT } from "../shop-services"
import type { BillingClaim } from "../billing-guard"
import { safeDbError } from "../log-safe"
import { finish, goto, say, type FlowCtx, type RouterDeps, type StepTable } from "../flow-kit"
import type { HubtelReply, HubtelRequest, HubtelSession } from "../types"

const CODE = { label: "Shop code", fieldType: "text" as const }
const PRODUCT = { label: "Shop menu" }
/** ussd_shop_codes.code is VARCHAR(8), generated as 4-6 digits. Anything else is not a code. */
const SHOP_CODE_RE = /^[A-Za-z0-9]{1,8}$/

const INVALID = "Invalid code. Try again."
const UNAVAILABLE = "Shop unavailable. Try again."
const NO_SESSIONS = "Shop has no sessions left."
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
  // Checked BEFORE the code is asked (D4), so no shop token is ever spent on an empty menu.
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

async function enterCode(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, req } = ctx
  if (input === "0") return finish(ctx, "Goodbye.")
  const retry = (reason: string) => say(ctx, shopCodeRetryText(reason), "SHOP_ENTER_CODE", CODE)
  // A wrong / malformed / inactive code counts toward the per-session cap (no guessing codes in one
  // session). "No sessions left" and "unavailable" are not wrong codes and do not count.
  const wrongCode = async (): Promise<HubtelReply> => {
    const attempts = (ctx.session.shopCodeAttempts ?? 0) + 1
    if (attempts >= MAX_CODE_ATTEMPTS) return finish(ctx, TOO_MANY)
    return goto(ctx, { step: "SHOP_ENTER_CODE", shopCodeAttempts: attempts }, shopCodeRetryText(INVALID), CODE)
  }
  if (!SHOP_CODE_RE.test(input)) return wrongCode()

  const shop = await deps.shop.resolveCode(input)
  if (!shop || shop.status !== "active") return wrongCode()

  // One token per (Hubtel session, shop code). The marker is taken BEFORE deducting, so two
  // concurrent deliveries cannot both deduct; "already" means this session has paid for this
  // code (lost-reply retry or "Session expired" restart) and must not pay again, even at balance 0.
  let claim: BillingClaim
  try {
    claim = await deps.shopBilling.claim(req.SessionId, shop.shopCodeId)
  } catch (e) {
    console.error("[HUBTEL-SHOP] Billing marker claim threw for shop code id", shop.shopCodeId, safeDbError(e))
    claim = "error"
  }
  if (claim === "error") return retry(UNAVAILABLE) // guard unavailable: never deduct unguarded
  if (claim === "claimed") {
    // Definitely not deducted yet: release the marker so a later attempt (after a top-up) can pay.
    if (!(shop.tokenBalance > 0)) {
      await deps.shopBilling.release(req.SessionId, shop.shopCodeId)
      return retry(NO_SESSIONS)
    }
    let deducted: boolean
    try {
      deducted = await deps.shop.deductToken(shop.shopCodeId) // atomic: balance > 0 AND status active
    } catch (e) {
      // An RPC error (timeout, 504) can hide a committed deduction: KEEP the marker so a retry in
      // this session is accepted without paying again. Worst case one free session, never a double charge.
      console.error("[HUBTEL-SHOP] Token deduction failed for shop code id", shop.shopCodeId, safeDbError(e))
      return retry(UNAVAILABLE)
    }
    if (deducted !== true) {
      // The RPC definitely deducted nothing (balance reached 0 concurrently, or the code was deactivated).
      await deps.shopBilling.release(req.SessionId, shop.shopCodeId)
      return retry(NO_SESSIONS)
    }
    // Uzo rule: alert the owner when this deduction leaves exactly 10 sessions (pre-read balance - 1).
    if (shop.tokenBalance - 1 === LOW_TOKEN_ALERT_AT) await deps.shop.notifyLowTokens(shop.shopId, shop.shopName)
  }

  // A shop may sell only airtime / vouchers: an empty network list does not block entry (Uzo).
  // The token may already be spent here, so a lookup failure must not fail the request: continue
  // with no networks (the data flow then says there is nothing to buy) and log ids only.
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
