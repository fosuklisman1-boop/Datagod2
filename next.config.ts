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
  // Security headers handled by Vercel
  headers: async () => {
    return [
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

