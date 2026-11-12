import type { Metadata } from "next"
import { assertShopCanSell, shopServicePageMetadata } from "@/lib/seo/shop-service-page"

// The storefront's AFA registration form: its own canonical (it's linked
// from the storefront when the shop sets an AFA price), noindex otherwise.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  return shopServicePageMetadata(slug, {
    subpath: "/afa",
    heading: "AFA Registration",
    describe: (name) => `Register your line for AFA bundles with ${name}. Fill in your details and pay securely with Mobile Money.`,
    offered: (shop) => shop.afa_price != null,
  })
}

export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  await assertShopCanSell((await params).slug)
  return children
}
