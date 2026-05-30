import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Disable ESLint during build on production/Vercel
  // ESLint warnings shouldn't block production builds
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Vercel-optimized settings
  compress: true,
  productionBrowserSourceMaps: false,
  // Image optimization
  images: {
    unoptimized: false,
    formats: ["image/avif", "image/webp"],
  },
  // Redirects
  redirects: async () => {
    return [
      // Removed favicon redirect - Google prefers direct access to /favicon.ico
      // Marketing and common routes
      {
        source: "/community",
        destination: "/join",
        permanent: false,
      },
      {
        source: "/register",
        destination: "/auth/signup",
        permanent: false,
      },
      {
        source: "/login",
        destination: "/auth/login",
        permanent: false,
      },
      // Dashboard shortcuts
      {
        source: "/packages",
        destination: "/dashboard/data-packages",
        permanent: false,
      },
      {
        source: "/orders",
        destination: "/dashboard/my-orders",
        permanent: false,
      },
      {
        source: "/wallet",
        destination: "/dashboard/wallet",
        permanent: false,
      },
    ];
  },
  // Security headers handled by Vercel
  headers: async () => {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Service-Worker-Allowed",
            value: "/",
          },
        ],
      },
      {
        source: "/favicon-v2.jpeg",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/favicon_custom.ico",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          {
            key: "X-XSS-Protection",
            value: "1; mode=block",
          },
          // HSTS: tell browsers to only connect over HTTPS for 2 years,
          // covering all subdomains. 'preload' qualifies the domain for
          // browser preload lists (submit at https://hstspreload.org).
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          // CSP is injected per-request by middleware (needs a fresh nonce each time).
          // Static headers here cannot carry a nonce, so CSP lives in middleware.ts.
        ],
      },
    ];
  },
};

export default withBotId(nextConfig);

