import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Available Data Packages | Buy Data Online | DATAGOD",
  description: "Browse all available data packages from MTN, Telecel, AT, and other networks. Find the perfect package for your needs.",
  robots: {
    index: false,
    follow: true,
  },
  openGraph: {
    title: "Available Data Packages | Buy Data Online | DATAGOD",
    description: "Explore affordable data packages from all major networks in Ghana.",
    type: "website",
    url: "https://www.datagod.store/dashboard/data-packages",
  },
}

export default function DataPackagesLayout({ children }: { children: React.ReactNode }) {
  return children
}
