import { openPricedShop } from "./open-shop"

export interface JoinerShopState {
  joined_via?: string | null
  is_active?: boolean | null
  prices_set_at?: string | null
  parent_shop_id?: string | null
}

export interface OpenAfterSave {
  opened?: boolean
  ussdCode?: string
  subdomain?: string
}

/**
 * After a sub-agent saves prices: if the caller's shop is a closed storefront joiner, open it (the spec says
 * "they save prices and the shop opens"). Any other shop (invite sub-agent, main shop, already-open joiner) gets
 * {} and openPricedShop is not called. Never throws: a failure to open must not fail the save, the "Save and open"
 * button still works.
 */
export async function openClosedJoinerAfterSave(db: any, userId: string, shop: JoinerShopState): Promise<OpenAfterSave> {
  const closedJoiner =
    !!shop.parent_shop_id && shop.joined_via === "storefront" && shop.is_active !== true && !shop.prices_set_at
  if (!closedJoiner) return {}
  try {
    const result = await openPricedShop(db, userId)
    if (result.status === "opened" || result.status === "already_open") {
      return { opened: true, ussdCode: result.ussdCode, subdomain: result.subdomain }
    }
    return { opened: false }
  } catch (e) {
    console.warn("[SUB-AGENT-CATALOG] auto-open after save failed:", e instanceof Error ? e.name : "unknown")
    return { opened: false }
  }
}
