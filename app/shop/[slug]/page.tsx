import { shopService } from "@/lib/shop-service"
import ShopStorefront from "./storefront-client"

// Thin server shell: fetches just enough (logo_url, shop_name) so the
// client component's initial loading screen can show the shop's OWN
// branding immediately, instead of the platform's — without waiting on
// the client component's own, separate shop fetch. Same getShopBySlug
// call this route's layout.tsx already makes for generateMetadata; an
// extra lightweight call here, not a shared one, since a client
// component can't receive data a layout fetched.
export default async function ShopPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const shop = await shopService.getShopBySlug(slug).catch(() => null)

  return (
    <ShopStorefront
      initialLogoUrl={shop?.logo_url ?? null}
      initialShopName={shop?.shop_name ?? null}
    />
  )
}
