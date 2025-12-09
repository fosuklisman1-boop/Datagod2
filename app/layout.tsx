import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/components/auth-provider";
import { ChristmasThemeProvider } from "@/components/christmas-theme-provider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "DATAGOD - Data Packages & Services",
  description: "Buy affordable data packages from multiple networks with instant delivery",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://datagod.com",
    siteName: "DATAGOD",
    title: "DATAGOD - Data Packages & Services",
    description: "Buy affordable data packages from multiple networks with instant delivery",
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
            {children}
            <Toaster />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
