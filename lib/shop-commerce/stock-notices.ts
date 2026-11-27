// Out-of-stock notices for ONE shop's storefront: the admin's reason for each network the shop sells
// that the admin marked out of stock. Fails open to {} so the storefront looks exactly as it did before.
import type { SupabaseClient } from "@supabase/supabase-js"
import { getStockNotices } from "@/lib/network-stock-service"
import type { StockNotices } from "@/lib/network-stock-notice"
import { noticesForShop } from "@/lib/shop-stock-networks"
import { fetchShopNetworks } from "./shop-code"

export async function loadShopStockNotices(
  supabase: SupabaseClient,
  shopId: string,
  parentShopId: string | null | undefined
): Promise<StockNotices> {
  try {
    const notices = await getStockNotices(supabase)
    if (Object.keys(notices).length === 0) return {}
    const sold = await fetchShopNetworks(shopId, parentShopId ?? null, supabase as any, { includeUnavailable: true })
    return noticesForShop(sold, notices)
  } catch {
    console.error("[SHOP-STOCK] notices load failed for shop", shopId)
    return {}
  }
}
