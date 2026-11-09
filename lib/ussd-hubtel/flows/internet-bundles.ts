// lib/ussd-hubtel/flows/internet-bundles.ts
// "Internet Bundles": the single top-level item on both Hubtel codes that fronts Data Bundles and Standard
// Bundles. With both types visible it shows a small type screen; with one it goes straight to that flow.
// This file imports no flow's start function (the router passes them in), which avoids an import cycle:
// the flows import backFromInternetType from here.
import { keyForDigit } from "@/lib/ussd/menu-items"
import { backToMain, goto, say, type FlowCtx, type StepHandler } from "../flow-kit"
import { internetMenuText, resolveInternetTypes, type InternetType } from "../menus"
import type { HubtelReply, HubtelSession } from "../types"
import { backToProduct } from "./shop"

const SCREEN = { label: "Internet bundles" }

/** The internet bundle types this caller may open right now (same inputs the menus render from). */
export function internetTypesFor(ctx: FlowCtx): InternetType[] {
  return resolveInternetTypes(ctx.config.visibility, ctx.session.dataBlocked === true, ctx.config.botMenus)
}

/** Back to the main menu (main mode) or the shop's product menu (shop mode). */
const toTop = (ctx: FlowCtx, prefix = "") => (ctx.session.mode === "shop" ? backToProduct(ctx, prefix) : backToMain(ctx))

/** Same fields backToMain / backToProduct keep: nothing from the flow the caller just left. */
function cleanSession(s: HubtelSession): HubtelSession & { step: "INTERNET_MENU" } {
  if (s.mode === "shop") {
    return {
      mode: "shop", step: "INTERNET_MENU", dialingPhone: s.dialingPhone, platform: s.platform, dataBlocked: s.dataBlocked,
      shopCodeId: s.shopCodeId, shopId: s.shopId, parentShopId: s.parentShopId, shopName: s.shopName, shopNetworks: s.shopNetworks,
    }
  }
  return { step: "INTERNET_MENU", dialingPhone: s.dialingPhone, platform: s.platform, dataBlocked: s.dataBlocked }
}

/**
 * "Back" from the first screen of a type: the Internet Bundles screen when there are two types to choose
 * from, otherwise the main / shop menu (the screen would have a single line). `prefix` is a notice for the
 * shop menu, as backToProduct takes it.
 */
export async function backFromInternetType(ctx: FlowCtx, prefix = ""): Promise<HubtelReply> {
  const types = internetTypesFor(ctx)
  if (types.length !== 2) return toTop(ctx, prefix)
  const clean = cleanSession(ctx.session)
  return goto({ ...ctx, session: clean }, clean, prefix + internetMenuText(types), SCREEN)
}

/** The main / shop menu item: one type opens its flow directly, two show the type screen. */
export function startInternetBundles(entries: Partial<Record<InternetType, StepHandler>>): StepHandler {
  return async ctx => {
    const types = internetTypesFor(ctx)
    if (types.length === 1) {
      const start = entries[types[0]]
      if (start) return start(ctx)
    }
    if (types.length === 2) return goto(ctx, { step: "INTERNET_MENU" }, internetMenuText(types), SCREEN)
    return toTop(ctx)
  }
}

/** INTERNET_MENU: render and dispatch both come from the same visible list, built per request. */
export function internetMenuStep(entries: Partial<Record<InternetType, StepHandler>>): StepHandler {
  return async ctx => {
    if (ctx.input === "0") return toTop(ctx)
    const types = internetTypesFor(ctx)
    if (types.length === 0) return toTop(ctx)
    const resolved = types.map((key, i) => ({ key, digit: i + 1, label: key }))
    const key = keyForDigit(resolved, ctx.input)
    const start = key ? entries[key] : undefined
    return start ? start(ctx) : say(ctx, internetMenuText(types), "INTERNET_MENU", SCREEN)
  }
}
