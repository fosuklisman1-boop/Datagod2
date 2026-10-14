import type { CashbackConfig } from "@/lib/cashback/config"
import { quoteBots } from "@/lib/cashback/quote"
import type { BundleNetwork } from "@/lib/standard-bundles/categories"
import type { BundlesDeps } from "@/lib/standard-bundles/service"
import { pricedCatalog, type StorefrontCatalogResult } from "@/lib/storefront-commission/bundles"
import { fail, NOT_AVAILABLE, UNAVAILABLE, type Fail } from "@/lib/storefront-commission/shop"
import { botGroupOn, resolveBotContext, type BotContext } from "./context"

/** Bots bundles switch (master AND bots surface AND "sell on bots" for bundles). */
export async function botBundlesCfg(d: Pick<BundlesDeps, "getCashbackConfig">): Promise<{ ok: true; cfg: CashbackConfig } | Fail> {
  let cfg: CashbackConfig
  try { cfg = await d.getCashbackConfig() } catch { return fail(503, UNAVAILABLE) }
  if (!botGroupOn(cfg, "bundles")) return fail(403, NOT_AVAILABLE)
  return { ok: true, cfg }
}

export type BotCatalogResult = StorefrontCatalogResult

/**
 * The dashboard catalog (same gates, cache and signed catalog tokens) with this bot's price on every plan:
 * quoteBots for the bot's rail and shop/main split. Nothing is sold while Hubtel is paused.
 */
export async function botCatalog(d: BundlesDeps, ctx: BotContext, network: BundleNetwork): Promise<BotCatalogResult> {
  const c = resolveBotContext(ctx)
  if (!c.ok) return c
  const { rail, shopId } = c.ctx
  return pricedCatalog(d, network, () => botBundlesCfg(d),
    (cfg, serviceKey, face) => quoteBots({ serviceKey, provider: "hubtel", faceAmount: face, rail, shop: shopId !== null }, cfg))
}
