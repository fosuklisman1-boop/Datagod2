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
        ],
      },
    ];
  },
};

export default nextConfig;

