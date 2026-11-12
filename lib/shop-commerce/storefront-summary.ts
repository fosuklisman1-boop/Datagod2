import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { normalizeWhatsAppLink } from "@/lib/whatsapp-link"
import { loadPublicShopPackages } from "./public-packages"
import { buildShopPriceTable, type PriceTable } from "./price-table"

// Server-only: the data behind the server-rendered storefront summary in
// app/shop/[slug]/page.tsx. Prices come from loadPublicShopPackages, the same
// loader /api/shop/public-packages uses, so they match the interactive client.

export interface StorefrontSummary {
  table: PriceTable
  orderingEnabled: boolean
  whatsappLink: string | null
}

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

/** Null when the shop or its packages can't be read; the page then renders without a table. */
export async function loadStorefrontSummary(handle: string): Promise<StorefrontSummary | null> {
  const supabase = serviceClient()
  if (!supabase) return null
  try {
    const { data: shop } = await supabase
      .from("user_shops")
      .select("id, user_id, parent_shop_id")
      .or(shopHandleOrFilter(handle))
      .eq("is_active", true)
      .single()
    if (!shop) return null

    const [loaded, settingsRes, shopSettingsRes] = await Promise.all([
      loadPublicShopPackages(supabase, shop),
      supabase.from("app_settings").select("ordering_enabled").is("key", null),
      supabase.from("shop_settings").select("whatsapp_link").eq("shop_id", shop.id).maybeSingle(),
    ])
    if (!loaded.ok) return null

    const settings = Array.isArray(settingsRes.data) ? settingsRes.data[0] : settingsRes.data
    return {
      table: buildShopPriceTable(loaded.packages, loaded.exactPriceIds),
      orderingEnabled: (settings as { ordering_enabled?: boolean } | null)?.ordering_enabled ?? true,
      whatsappLink: normalizeWhatsAppLink(shopSettingsRes.data?.whatsapp_link),
    }
  } catch (e) {
    console.error("[STOREFRONT-SUMMARY] Failed to load:", e instanceof Error ? e.message : e)
    return null
  }
}
