import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { lookupShop } from "@/lib/shop-commerce/shop-lookup"
import type { DomainService } from "@/lib/custom-domains"
import { shopCanonicalBase, shopCanonicalUrl, shopRequestContext } from "./shop-canonical"

/**
 * Metadata for a storefront's own service pages (/afa, /airtime): their own
 * title and canonical instead of the inherited shop-root canonical. Noindex
 * when the page sells nothing here (shop not found/blocked, AFA not offered,
 * or a custom domain scoped away from the service).
 */
export async function shopServicePageMetadata(
  slug: string,
  opts: { subpath: string; heading: string; describe: (shopName: string) => string; service?: DomainService; offered?: (shop: { afa_price: number | null }) => boolean },
): Promise<Metadata> {
  const { shop } = await lookupShop(slug)
  if (!shop || shop.is_blocked) return { robots: { index: false, follow: false } }
  const { domainConfig } = await shopRequestContext()
  const scopedOut = !!opts.service && !!domainConfig?.services?.length && !domainConfig.services.includes(opts.service)
  const offered = opts.offered ? opts.offered(shop) : true
  const url = shopCanonicalUrl(shopCanonicalBase(shop, domainConfig?.domain), opts.subpath)
  const title = `${opts.heading} | ${shop.shop_name}`
  const description = opts.describe(shop.shop_name)
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, siteName: shop.shop_name, title, description },
    ...(scopedOut || !offered ? { robots: { index: false, follow: true } } : {}),
  }
}

/** Layout guard for a service page: a blocked shop can't sell, so 404 (unknown shops 404 in the shop layout). */
export async function assertShopCanSell(slug: string): Promise<void> {
  const { shop } = await lookupShop(slug)
  if (shop?.is_blocked) notFound()
}
