import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
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

const inter = Inter({ subsets: ["latin"] });

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
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
    statusBarStyle: "default",
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Organization Schema */}
        <script
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
        {/* Paystack Script */}
        <script src="https://js.paystack.co/v1/inline.js" async></script>
        {/* Service Worker Registration - inline for PWA detection */}
        <script
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
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
          <AuthProvider>
            <ServiceWorkerRegister />
            <PeriodicSyncRegister />
            <BackgroundSyncRegister />
            <PushNotificationRegister />
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
