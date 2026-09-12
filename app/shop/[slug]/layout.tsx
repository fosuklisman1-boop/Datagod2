import type { Metadata } from 'next'
import { shopService } from '@/lib/shop-service'
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

  // Some shops predate the subdomain backfill and have no subdomain yet —
  // same fallback as app/sitemap.ts, so canonical and sitemap never disagree.
  const canonicalUrl = shop.subdomain
    ? `https://${shop.subdomain}.${ROOT_DOMAIN}`
    : `https://www.${ROOT_DOMAIN}/shop/${shop.shop_slug}`
  const title = `${shop.shop_name} - Buy Data & Airtime Online | Powered by DATAGOD`
  const description =
    shop.description ||
    `Buy affordable data bundles, airtime, and results checker vouchers from ${shop.shop_name}. Instant delivery, secure payment.`
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
