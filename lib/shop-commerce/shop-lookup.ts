import { cache } from "react"
import { createClient } from "@supabase/supabase-js"
import { shopService, type PublicShop } from "@/lib/shop-service"
import { sanitizeShopHandle } from "@/lib/shop-handle"

/**
 * Server-only, deduped per request (generateMetadata, layout and page all
 * ask). `failed` is true when the lookup itself errored: callers must not
 * treat that as "no such shop" (a database hiccup must never 404 a real shop).
 */
export const lookupShop = cache(async (slug: string): Promise<{ shop: PublicShop | null; failed: boolean }> => {
  try {
    return { shop: await shopService.getShopBySlug(slug), failed: false }
  } catch (e) {
    console.error("[SHOP-LOOKUP] getShopBySlug failed:", e instanceof Error ? e.message : e)
    return { shop: null, failed: true }
  }
})

/**
 * A rotated/old shop slug -> the shop's current handles, or null. Service-role:
 * previous_slugs is private. Used by /api/shop/resolve-alias and the storefront
 * page (which redirects instead of 404ing).
 */
export async function resolveShopAlias(raw: string): Promise<{ shop_slug: string; subdomain: string | null } | null> {
  const slug = sanitizeShopHandle(raw)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!slug || !url || !key) return null
  try {
    const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
    // previous_slugs @> {slug}. If the column doesn't exist yet (pre-migration)
    // this errors and we return null.
    const { data, error } = await supabase
      .from("user_shops")
      .select("shop_slug, subdomain")
      .contains("previous_slugs", [slug])
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    if (error || !data?.shop_slug || data.shop_slug === slug) return null
    return { shop_slug: data.shop_slug, subdomain: data.subdomain ?? null }
  } catch {
    return null
  }
}
