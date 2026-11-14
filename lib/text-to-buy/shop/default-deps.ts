import type { SupabaseClient } from "@supabase/supabase-js"
import type { ResolvedShopCode } from "../../shop-commerce/shop-code"
import type { ShopResolveDeps } from "./resolve"

/**
 * Production wiring for resolveShopForText. Nothing here builds a client at import time: shop-code.ts creates a
 * service-role client when it loads, so it is imported lazily and handed the lane's own client instead.
 * Used by the shop lane; resolve.ts itself stays pure.
 */
export function defaultShopResolveDeps(db: SupabaseClient): ShopResolveDeps {
  const lookup = async (code: string): Promise<ResolvedShopCode | null> => {
    const { resolveShopCode } = await import("../../shop-commerce/shop-code")
    return resolveShopCode(code, db as unknown as Parameters<typeof resolveShopCode>[1])
  }
  return {
    resolveShopCode: lookup,
    getShopPref: async (sender) => (await import("../store")).getShopPref(db, sender),
    setShopPref: async (sender, shopCodeId) => (await import("../store")).setShopPref(db, sender, shopCodeId),
    lastBoughtShopCodeId: async (senderLocal) => (await import("../store")).lastBoughtShopCodeId(db, senderLocal),
    shopCodeById: (shopCodeId) => shopCodeByIdWith(db, lookup, shopCodeId),
  }
}

/** A remembered shop id back to its current facts: id to code string to the exact code lookup. Null when the id is gone. */
export async function shopCodeByIdWith(
  db: Pick<SupabaseClient, "from">,
  lookup: (code: string) => Promise<ResolvedShopCode | null>,
  shopCodeId: string,
): Promise<ResolvedShopCode | null> {
  const { data, error } = await db.from("ussd_shop_codes").select("code").eq("id", shopCodeId).maybeSingle()
  const code = (data as { code?: unknown } | null)?.code
  if (error || typeof code !== "string" || !code) return null
  return lookup(code)
}
