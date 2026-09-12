import { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.datagod.store'

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/shop/'],
        // Admin/dashboard/api are auth-gated with no indexable content. The
        // /auth/* functional routes (OAuth callback, email confirm, password
        // reset, profile completion, mobile handoff) carry one-time tokens in
        // their query strings and have no SEO value — crawling them serves no
        // purpose and could touch a live token. /auth/login, /auth/signup and
        // /auth/forgot-password are deliberately left crawlable (see their
        // layout.tsx) so Google can see their `noindex` meta tag rather than
        // just blindly listing an un-crawled URL.
        disallow: [
          '/admin',
          '/admin-setup',
          '/api',
          '/dashboard',
          '/auth/callback',
          '/auth/confirm',
          '/auth/reset-password',
          '/auth/complete-profile',
          '/auth/mobile-handoff',
        ],
        crawlDelay: 1,
      },
      {
        userAgent: 'AdsBot-Google',
        allow: '/',
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  }
}
