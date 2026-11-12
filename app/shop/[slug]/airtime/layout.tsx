import type { Metadata } from "next"
import { assertShopCanSell, shopServicePageMetadata } from "@/lib/seo/shop-service-page"

// The storefront's airtime top-up form: its own canonical instead of the
// shop-root one.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  return shopServicePageMetadata(slug, {
    subpath: "/airtime",
    heading: "Buy Airtime",
    describe: (name) => `Top up MTN, Telecel and AT airtime with ${name}. Pay securely with Mobile Money.`,
    service: "airtime",
  })
}

export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  await assertShopCanSell((await params).slug)
  return children
}
