import { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.datagod.store'

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/shop/', '/'],
        disallow: ['/admin', '/admin-setup', '/auth', '/dashboard', '/api'],
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
