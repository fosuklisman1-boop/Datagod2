import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { shopService } from '@/lib/shop-service'
import { resolveCustomDomain } from '@/lib/custom-domain-lookup'
import { SERVICE_LABELS, joinServiceLabels, normalizeDomainHost } from '@/lib/custom-domains'
import ShopClientWrapper from './shop-client-wrapper'

// Mirrors the ROOT_DOMAIN used by middleware.ts and app/sitemap.ts. Not
// imported from lib/shop-url.ts's shopOrigin() because that file is a
// "use client" module — Next.js proxies every export of a client module for
// server consumption, so a plain utility function from it can't be safely
// called here in a server-only generateMetadata().
const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'datagod.store').toLowerCase()

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
  const shop = await shopService.getShopBySlug(slug).catch(() => null)

  if (!shop || shop.is_blocked) {
    return {
      title: 'Shop Not Found | DATAGOD',
      robots: { index: false, follow: false },
    }
  }

  // Resolve the custom domain (if any) by the ACTUAL request host, not
  // shop.linked_custom_domain -- that field only covers a domain directly
  // linked to one shop (get_linked_custom_domain), not a wildcard-mode
  // domain (any active shop's subdomain reachable under it), which is how
  // middleware itself decides whether this request is custom-domain-scoped.
  const headersList = await headers()
  const requestHost = normalizeDomainHost(headersList.get('host'))
  const domainConfig = requestHost ? await resolveCustomDomain(requestHost).catch(() => null) : null

  // Some shops predate the subdomain backfill and have no subdomain yet —
  // same fallback as app/sitemap.ts, so canonical and sitemap never disagree.
  const canonicalUrl = shop.subdomain
    ? `https://${shop.subdomain}.${domainConfig?.domain || ROOT_DOMAIN}`
    : `https://www.${ROOT_DOMAIN}/shop/${shop.shop_slug}`

  // A shop reached through a custom domain restricted to a subset of
  // services (see lib/custom-domains.ts) must never advertise a service it
  // doesn't actually offer there -- this previously always said "Buy Data &
  // Airtime Online" regardless of what that domain's visitors can reach.
  const restrictedServices = domainConfig?.services?.length ? domainConfig.services : null
  const serviceLabel = restrictedServices
    ? joinServiceLabels(restrictedServices.map(s => SERVICE_LABELS[s]))
    : null
  const serviceLabelCapitalized = serviceLabel ? serviceLabel.charAt(0).toUpperCase() + serviceLabel.slice(1) : null

  // A shop reached through its own custom domain is deliberately
  // white-labeled -- the whole point of attaching one's own domain is to not
  // reveal the underlying platform, so "Powered by DATAGOD" only appears on
  // the plain <shop>.datagod.store subdomain.
  const poweredBySuffix = domainConfig ? '' : ' | Powered by DATAGOD'

  const title = serviceLabelCapitalized
    ? `${shop.shop_name} - Buy ${serviceLabelCapitalized} Online${poweredBySuffix}`
    : `${shop.shop_name} - Buy Data & Airtime Online${poweredBySuffix}`
  const description =
    shop.description ||
    (serviceLabel
      ? `Get instant ${serviceLabel} from ${shop.shop_name}. Instant delivery, secure payment.`
      : `Buy affordable data bundles, airtime, and results checker vouchers from ${shop.shop_name}. Instant delivery, secure payment.`)
  const image = shop.banner_url || shop.logo_url || 'https://www.datagod.store/og-image.png'

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      type: 'website',
      url: canonicalUrl,
      siteName: shop.shop_name,
      title,
      description,
      images: [{ url: image, width: 1200, height: 630, alt: shop.shop_name }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image],
    },
  }
}

export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}) {
  return <ShopClientWrapper>{children}</ShopClientWrapper>
}
