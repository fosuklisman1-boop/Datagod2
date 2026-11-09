import { notFound, permanentRedirect } from "next/navigation"
import { lookupShop, resolveShopAlias } from "@/lib/shop-commerce/shop-lookup"
import { loadStorefrontSummary } from "@/lib/shop-commerce/storefront-summary"
import { buildShopItemListJsonLd } from "@/lib/shop-commerce/price-table"
import { shopCanonicalBase, shopRequestContext } from "@/lib/seo/shop-canonical"
import ShopStorefront from "./storefront-client"
import { StorefrontSummary } from "./storefront-summary"
import { getShopPublicState } from "@/lib/sub-agents/open-shop"

function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // Shop names are owner-controlled: escape "<" so "</script>" can't break out.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  )
}

// Server shell: renders the storefront summary (name, description, logo, the
// data-bundle price table at this shop's selling prices, contact, and the
// Product ItemList JSON-LD) into the HTML, then hands over to the interactive
// client storefront. The summary is passed to ShopStorefront as its loading
// view, so it is in the server HTML and is replaced (not duplicated) once the
// client has loaded its own data. Prices come from the same loader as
// /api/shop/public-packages, which the client reads.
export default async function ShopPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const { shop, failed } = await lookupShop(slug)

  if (failed) {
    // The lookup errored (not "no such shop"): never 404 a real shop over a
    // database hiccup. Leave it to the client storefront's own fetch.
    return <ShopStorefront initialLogoUrl={null} initialShopName={null} />
  }

  if (!shop) {
    // A rotated/old slug: send it to the shop's current address (this used to
    // happen client-side after a 200 "Store not found"). Otherwise a real 404.
    const alias = await resolveShopAlias(slug)
    if (alias) {
      const { domainConfig } = await shopRequestContext()
      permanentRedirect(shopCanonicalBase(alias, domainConfig?.domain))
    }
    // An unpriced storefront sub-agent joiner shows "This shop isn't open yet"
    // (getShopPublicState); every other inactive or unknown handle is a real 404.
    if ((await getShopPublicState(slug)) === "setting_up") {
      return <ShopStorefront initialLogoUrl={null} initialShopName={null} publicState="setting_up" />
    }
    notFound()
  }

  // A blocked shop can't take orders (the order route answers 503). The
  // storefront had no customer-facing "blocked" message (it rendered normally
  // and its metadata already said "Shop Not Found", noindex), so it 404s.
  // Its order-status / confirmation subpages keep working for customers who
  // already paid.
  if (shop.is_blocked) notFound()

  const [summary, { domainConfig }] = await Promise.all([
    loadStorefrontSummary(slug),
    shopRequestContext(),
  ])
  const url = shopCanonicalBase(shop, domainConfig?.domain)
  // A custom domain scoped to services without data bundles shows no data on
  // the storefront, so the summary leaves the price table out too.
  const sellsData = !domainConfig?.services?.length || domainConfig.services.includes("data_bundles")
  const itemList =
    summary && sellsData
      ? buildShopItemListJsonLd({ shopName: shop.shop_name, url, table: summary.table, orderingEnabled: summary.orderingEnabled })
      : null
  // No BreadcrumbList: its only parent crumb would be the DATAGOD homepage,
  // and storefronts must not point their customers at the main site (whose
  // prices are below the shop's). A one-crumb breadcrumb says nothing.

  return (
    <>
      {itemList && <JsonLd data={itemList} />}
      <ShopStorefront
        initialLogoUrl={shop.logo_url ?? null}
        initialShopName={shop.shop_name ?? null}
        publicState="open"
        serverSummary={
          <StorefrontSummary
            shopName={shop.shop_name}
            description={shop.description}
            logoUrl={shop.logo_url}
            table={summary?.table ?? null}
            showPrices={sellsData}
            whatsappLink={summary?.whatsappLink ?? null}
            accentColor={shop.custom_color}
          />
        }
      />
    </>
  )
}
