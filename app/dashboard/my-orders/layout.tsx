import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "My Orders | Track Your Purchases | DATAGOD",
  description: "View and track all your DATAGOD orders. Check delivery status, package details, and order history.",
  robots: {
    index: false,
    follow: true,
  },
  openGraph: {
    title: "My Orders | Track Your Purchases | DATAGOD",
    description: "Track all your DATAGOD data package and airtime orders.",
    type: "website",
    url: "https://www.datagod.store/dashboard/my-orders",
  },
}

export default function MyOrdersLayout({ children }: { children: React.ReactNode }) {
  return children
}
