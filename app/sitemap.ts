import { MetadataRoute } from 'next'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 3600 // Revalidate every hour

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.datagod.store'
  const rootDomain = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'datagod.store').toLowerCase()

  // Static routes. /auth/login and /auth/signup are deliberately excluded:
  // their own metadata sets `robots: { index: false }` (see their layout.tsx
  // files), and listing a noindex URL in the sitemap is a known Search
  // Console anti-pattern ("Excluded by noindex tag").
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: `${baseUrl}/join`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/vouchers`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ]

  // Dynamic shop routes
  let shopRoutes: MetadataRoute.Sitemap = []
  try {
    const { data: shops, error } = await supabase
      .from('user_shops')
      .select('shop_slug, subdomain, updated_at')
      .eq('is_active', true)
      .range(0, 49999) // Fetch up to 50,000 shops for sitemap

    if (!error && shops) {
      shopRoutes = shops.map((shop) => ({
        // Canonical storefront URL is the clean subdomain; fall back to the legacy
        // path for any shop that predates the subdomain backfill.
        url: shop.subdomain ? `https://${shop.subdomain}.${rootDomain}` : `${baseUrl}/shop/${shop.shop_slug}`,
        lastModified: new Date(shop.updated_at || new Date()),
        changeFrequency: 'weekly' as const,
        priority: 0.7,
      }))
    }
  } catch (error) {
    console.error('Error fetching shops for sitemap:', error)
    // Continue without shop routes if there's an error
  }

  // Dashboard routes are intentionally NOT in the sitemap: they're auth-gated
  // (middleware redirects unauthenticated requests, including every crawler,
  // straight to /auth/login) and robots.ts disallows /dashboard outright.
  // Submitting URLs here that robots.txt blocks trains Search Console to flag
  // them as errors instead of leaving the sitemap clean.
  return [...staticRoutes, ...shopRoutes]
}
