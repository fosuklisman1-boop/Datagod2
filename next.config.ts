import type { NextConfig } from "next";

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
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.paystack.co https://checkout.paystack.com; style-src 'self' 'unsafe-inline' https://paystack.com https://checkout.paystack.com; img-src 'self' data: https: blob:; font-src 'self' data:; frame-src https://checkout.paystack.com; connect-src 'self' https://api.paystack.co https://paystack.com https://checkout.paystack.com https://supabase.co https://*.supabase.co wss://*.supabase.co;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

