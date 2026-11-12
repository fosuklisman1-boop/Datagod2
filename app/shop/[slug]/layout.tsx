import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { lookupShop, resolveShopAlias } from '@/lib/shop-commerce/shop-lookup'
import { getShopPublicState } from '@/lib/sub-agents/open-shop'
import { SERVICE_LABELS, joinServiceLabels } from '@/lib/custom-domains'
import { shopCanonicalBase, shopRequestContext } from '@/lib/seo/shop-canonical'
import { shopIconUrl, shopPreviewDescription, shopPreviewImage } from '@/lib/shop-link-preview'
import ShopClientWrapper from './shop-client-wrapper'

// Without this, every storefront (potentially thousands of shop subdomains)
// inherited the root layout's metadata verbatim — same title, same
// description, and a canonical tag pointing at the main site. That canonical
// tag actively told Google "this page is a duplicate, index the homepage
// instead," so shops could never rank for their own name. Per-shop metadata
// with a canonical pointing at the shop's own subdomain fixes that.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const { shop } = await lookupShop(slug)

  if (!shop || shop.is_blocked) {
    return {
      title: 'Shop Not Found | DATAGOD',
      robots: { index: false, follow: false },
    }
  }

  // Resolve the custom domain (if any) by the ACTUAL request host, not
  // shop.linked_custom_domain (see lib/seo/shop-canonical.ts).
  const { domainConfig } = await shopRequestContext()
  const canonicalUrl = shopCanonicalBase(shop, domainConfig?.domain)

  // A shop reached through a custom domain restricted to a subset of
  // services (see lib/custom-domains.ts) must never advertise a service it
  // doesn't actually offer there -- this previously always said "Buy Data &
  // Airtime Online" regardless of what that domain's visitors can reach.
  const restrictedServices = domainConfig?.services?.length ? domainConfig.services : null
  const serviceLabel = restrictedServices
    ? joinServiceLabels(restrictedServices.map(s => SERVICE_LABELS[s]))
    : null
  const serviceLabelCapitalized = serviceLabel ? serviceLabel.charAt(0).toUpperCase() + serviceLabel.slice(1) : null

  // Shop titles carry only the shop's own name (no platform branding), on both
  // <shop>.datagod.store and custom domains: shop customers should not be
  // pointed at the platform, where base prices are lower than the shop's.
  const title = serviceLabelCapitalized
    ? `${shop.shop_name} - Buy ${serviceLabelCapitalized} Online`
    : `${shop.shop_name} - Buy Data & Airtime Online`
  const description = shopPreviewDescription(
    shop,
    serviceLabel
      ? `Get instant ${serviceLabel} from ${shop.shop_name}. Instant delivery, secure payment.`
      : `Buy affordable data bundles, airtime, and results checker vouchers from ${shop.shop_name}. Instant delivery, secure payment.`,
  )
  const image = shopPreviewImage(shop)
  const iconUrl = shopIconUrl(shop, domainConfig?.logo_url)

  return {
    ...(iconUrl ? { icons: { icon: iconUrl, apple: iconUrl, shortcut: iconUrl } } : {}),
    title,
    description,
    // Shops are kept out of search indexes (main-site SEO focus); middleware also sends X-Robots-Tag.
    robots: { index: false, follow: true },
    alternates: { canonical: canonicalUrl },
    openGraph: {
      type: 'website',
      url: canonicalUrl,
      siteName: shop.shop_name,
      title,
      description,
      images: [{ url: image.url, width: image.width, height: image.height, alt: shop.shop_name }],
    },
    twitter: {
      card: image.card,
      title,
      description,
      images: [image.url],
    },
  }
}

export default async function ShopLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}) {
  // Unknown shop: 404 for every storefront path, not a 200 "Store not found".
  // A lookup error is not "unknown", and a rotated slug is left to the page,
  // which redirects it. Blocked shops are handled by the pages (see page.tsx).
  const { slug } = await params
  const { shop, failed } = await lookupShop(slug)
  // An unpriced storefront sub-agent joiner is left to the page, which shows
  // "This shop isn't open yet" (getShopPublicState) instead of a 404.
  if (!shop && !failed && !(await resolveShopAlias(slug)) && (await getShopPublicState(slug)) !== "setting_up") notFound()
  return <ShopClientWrapper>{children}</ShopClientWrapper>
}
