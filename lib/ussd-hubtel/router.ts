// lib/ussd-hubtel/router.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { keyForDigit } from "@/lib/ussd/menu-items"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { getHubtelUssdConfig, type HubtelUssdConfig } from "./config"
import { defaultAfaServices, defaultAirtimeServices, defaultRcServices, resolveDialer } from "./services"
import { sessionStore } from "./session"
import { defaultShopServices } from "./shop-services"
import { shopBillingGuard } from "./billing-guard"
import { fetchBundles, PAGE_SIZE, resolveCaller, isDataBlocked } from "./catalog"
import { mainMenuText, type MainMenuKey, type ShopMenuKey } from "./menus"
import { release, respond, toE164 } from "./protocol"
import {
  finish, mainMenuReply, menuFor, replaySubmittedOrder,
  type FlowCtx, type RouterDeps, type StepHandler, type StepTable,
} from "./flow-kit"
import { AFA_STEPS, startAfa } from "./flows/afa"
import { AIRTIME_STEPS, startAirtime } from "./flows/airtime"
import { DATA_STEPS, startData } from "./flows/data"
import { RC_BUY_STEPS, startRc } from "./flows/rc-buy"
import { RC_CHECK_STEPS } from "./flows/rc-check"
import { SHOP_ENTRY_STEPS, shopMenuFor, shopMenuReply, startShopSession } from "./flows/shop"
import type { HubtelReply, HubtelRequest } from "./types"

export type { RouterDeps } from "./flow-kit"

export function defaultRouterDeps(supabase: SupabaseClient): RouterDeps {
  return {
    supabase,
    getConfig: () => getHubtelUssdConfig(supabase),
    sessions: sessionStore,
    fetchBundles,
    resolveCaller: phone => resolveCaller(supabase, phone),
    isDataBlocked: msisdn => isDataBlocked(supabase, msisdn),
    getPrefixConfig: getPrefixValidationConfig,
    pageSize: PAGE_SIZE,
    resolveDialer,
    airtime: defaultAirtimeServices(),
    rc: defaultRcServices(supabase),
    afa: defaultAfaServices(supabase),
    shop: defaultShopServices(supabase),
    shopBilling: shopBillingGuard,
  }
}

/** First screen of each main-menu service. Every IMPLEMENTED_SERVICES key must have one (tested). */
export const MAIN_MENU_ENTRIES: Partial<Record<MainMenuKey, StepHandler>> = {
  data: startData,
  airtime: startAirtime,
  resultsChecker: startRc,
  afa: startAfa,
}

const STEPS: StepTable = {
  MAIN: handleMain,
  ...DATA_STEPS,
  ...AIRTIME_STEPS,
  ...RC_BUY_STEPS,
  ...RC_CHECK_STEPS,
  ...AFA_STEPS,
}

/** First screen of each shop product (Tasks 3, 5, 6 register theirs). Shop mode only. */
export const SHOP_PRODUCT_ENTRIES: Partial<Record<ShopMenuKey, StepHandler>> = {}

/** Steps of a session pinned to shop mode. Never mixed with STEPS: a session runs one table. */
const SHOP_STEPS: StepTable = {
  ...SHOP_ENTRY_STEPS,
  SHOP_PRODUCT: handleShopProduct,
}

const UNAVAILABLE = "Service unavailable. Please try again later."

export async function hubtelRouter(req: HubtelRequest, deps: RouterDeps): Promise<HubtelReply> {
  const sid = req.SessionId
  const platform = req.Platform

  if (req.Type === "Timeout") {
    await deps.sessions.del(sid)
    return release(sid, "Session ended.", { platform })
  }

  const config = await deps.getConfig()
  // Kill switch: every request, including in-flight sessions of either mode (D2).
  if (!config.enabled) return release(sid, UNAVAILABLE, { platform })

  // Spec 4.2: the mode is read on Initiation and pinned into the session.
  if (req.Type === "Initiation") return startForMode(req, deps, config, "")

  const session = await deps.sessions.get(sid)
  if (!session) {
    // A retry after our first reply was lost: the session is already gone but the order exists.
    // Tried before any restart so a paid-for cart replays even across a mode flip.
    const replay = await replaySubmittedOrder(deps, sid, platform)
    if (replay) return replay
    return startForMode(req, deps, config, "Session expired.\n")
  }

  // Dispatch by the PINNED mode, never the current config (a session without one is main).
  const table = session.mode === "shop" ? SHOP_STEPS : STEPS
  const handler = table[session.step]
  if (!handler) return startForMode(req, deps, config, "")
  return handler({ input: req.Message.trim(), req, deps, config, session })
}

async function startSession(req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, prefix: string): Promise<HubtelReply> {
  const dataBlocked = await deps.isDataBlocked(req.Mobile)
  const resolved = menuFor(config, dataBlocked)
  if (resolved.length === 0) {
    await deps.sessions.del(req.SessionId)
    return release(req.SessionId, "No services available right now. Please try again later.", { platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, { mode: "main", step: "MAIN", dialingPhone: toE164(req.Mobile), platform: req.Platform, dataBlocked })
  return respond(req.SessionId, prefix + mainMenuText(resolved), { label: "Main menu", clientState: "MAIN", platform: req.Platform })
}

/** New or restarted session: the CURRENT config mode decides, and is pinned by the start function. */
function startForMode(req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, prefix: string): Promise<HubtelReply> {
  return config.mode === "shop" ? startShopSession(req, deps, config, prefix) : startSession(req, deps, config, prefix)
}

async function handleShopProduct(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return finish(ctx, "Goodbye.")
  const key = keyForDigit(shopMenuFor(ctx.config, ctx.session.dataBlocked === true), ctx.input)
  const start = key ? SHOP_PRODUCT_ENTRIES[key] : undefined
  return start ? start(ctx) : shopMenuReply(ctx)
}

async function handleMain(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return finish(ctx, "Thank you for using Datagod.")
  const key = keyForDigit(menuFor(ctx.config, ctx.session.dataBlocked === true), ctx.input)
  const start = key ? MAIN_MENU_ENTRIES[key] : undefined
  return start ? start(ctx) : mainMenuReply(ctx)
}
