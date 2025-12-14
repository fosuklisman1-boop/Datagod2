import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/components/auth-provider";
import { ChristmasThemeProvider } from "@/components/christmas-theme-provider";
import { InactivityLogoutProvider } from "@/components/inactivity-logout-provider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "DATAGOD - Affordable Data Packages & Services",
  description: "Buy affordable data packages from multiple networks with instant delivery. Shop data bundles from MTN, Telecel, AT, and more with 24/7 support.",
  keywords: ["data packages", "mobile data", "bundles", "MTN", "Telecel", "airtime", "Ghana"],
  icons: {
    icon: "/favicon.jpeg",
    apple: "/favicon.jpeg",
  },
  metadataBase: new URL("https://datagod.com"),
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
    canonical: "https://datagod.com",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://datagod.com",
    siteName: "DATAGOD",
    title: "DATAGOD - Affordable Data Packages & Services",
    description: "Buy affordable data packages from multiple networks with instant delivery",
    images: [
      {
        url: "https://datagod.com/og-image.png",
        width: 1200,
        height: 630,
        alt: "DATAGOD - Data Packages",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "DATAGOD - Affordable Data Packages & Services",
    description: "Buy affordable data packages from multiple networks with instant delivery",
    images: ["https://datagod.com/og-image.png"],
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
        {/* Paystack Script */}
        <script src="https://js.paystack.co/v1/inline.js" async></script>
      </head>
      <body className={inter.className}>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
          <AuthProvider>
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
