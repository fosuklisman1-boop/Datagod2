import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/components/auth-provider";
import { ChristmasThemeProvider } from "@/components/christmas-theme-provider";
import { InactivityLogoutProvider } from "@/components/inactivity-logout-provider";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { PeriodicSyncRegister } from "@/components/periodic-sync-register";
import { BackgroundSyncRegister } from "@/components/background-sync-register";
import { PushNotificationRegister } from "@/components/push-notification-register";
import { PushOptInBanner } from "@/components/push-opt-in-banner";

const inter = Inter({ subsets: ["latin"] });

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  // viewport-fit=cover extends content into the notch/Dynamic Island area so the
  // apple-touch-startup-image media queries can match the full physical screen height.
  viewportFit: "cover",
  themeColor: "#4f46e5",
};

export const metadata: Metadata = {
  title: "DATAGOD - Buy Affordable Data Packages & Airtime | Instant Delivery",
  description: "Get instant mobile data packages, airtime, and digital services for MTN, Telecel, AT, and other networks in Ghana. Fast delivery, secure payment, 24/7 support.",
  keywords: [
    "data packages Ghana",
    "mobile data",
    "airtime",
    "MTN data",
    "Telecel bundles",
    "buy data online",
    "data bundles Ghana",
    "instant data delivery",
  ],
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    // black-translucent: status bar overlays the app instead of consuming space,
    // allowing the splash image to fill the full screen including the notch area.
    statusBarStyle: "black-translucent",
    title: "DATAGOD",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
    shortcut: "/favicon.ico",
  },
  metadataBase: new URL("https://www.datagod.store"),
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: "https://www.datagod.store",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://www.datagod.store",
    siteName: "DATAGOD",
    title: "DATAGOD - Buy Affordable Data Packages & Airtime | Instant Delivery",
    description: "Get instant mobile data packages, airtime, and digital services for MTN, Telecel, AT, and other networks. Fast delivery, secure payment.",
    images: [
      {
        url: "https://www.datagod.store/og-image.png",
        width: 1200,
        height: 630,
        alt: "DATAGOD - Affordable Data Packages & Airtime",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@datagodstore",
    creator: "@datagodstore",
    title: "DATAGOD - Buy Data Packages & Airtime Online",
    description: "Instant mobile data, airtime, and digital services for Ghana. Fast delivery, secure payment.",
    images: ["https://www.datagod.store/og-image.png"],
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read the per-request nonce injected by middleware so inline scripts
  // satisfy the nonce-based Content-Security-Policy.
  const headersList = await headers();
  const nonce = headersList.get("x-nonce") ?? "";

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Organization Schema */}
        <script
          nonce={nonce}
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "DATAGOD",
              url: "https://www.datagod.store",
              logo: "https://www.datagod.store/favicon-v2.jpeg",
              description: "Affordable data packages, airtime, and mobile services for multiple networks in Ghana",
              sameAs: [
                "https://web.facebook.com/datagod.store",
                "https://twitter.com/datagodstore",
                "https://www.instagram.com/datagodstore",
              ],
              contactPoint: {
                "@type": "ContactPoint",
                contactType: "Customer Service",
                availableLanguage: ["en"],
              },
            }),
          }}
        />
        {/* iOS splash screens — auto-generated for all current Apple device sizes */}
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-2048-2732.jpg" media="(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1668-2388.jpg" media="(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1536-2048.jpg" media="(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1640-2360.jpg" media="(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1668-2224.jpg" media="(device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1620-2160.jpg" media="(device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1488-2266.jpg" media="(device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1320-2868.jpg" media="(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1206-2622.jpg" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1260-2736.jpg" media="(device-width: 420px) and (device-height: 912px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1290-2796.jpg" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1179-2556.jpg" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1170-2532.jpg" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1284-2778.jpg" media="(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1125-2436.jpg" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1242-2688.jpg" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-828-1792.jpg"  media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-1242-2208.jpg" media="(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-750-1334.jpg"  media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash/apple-splash-640-1136.jpg"  media="(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />

        {/* Capture beforeinstallprompt before React hydrates */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
              window.addEventListener('beforeinstallprompt', function(e) {
                e.preventDefault();
                window.__deferredInstallPrompt = e;
                window.dispatchEvent(new Event('pwaInstallReady'));
              });
            `,
          }}
        />
        {/* Paystack Script */}
        <script nonce={nonce} src="https://js.paystack.co/v1/inline.js" async></script>
        {/* Service Worker Registration - inline for PWA detection */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js');
                });
              }
            `,
          }}
        />
      </head>
      <body className={inter.className}>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
          <AuthProvider>
            <ServiceWorkerRegister />
            <PeriodicSyncRegister />
            <BackgroundSyncRegister />
            <PushNotificationRegister />
            <PushOptInBanner />
            <ChristmasThemeProvider />
            <InactivityLogoutProvider />
            {children}
            <Toaster />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
