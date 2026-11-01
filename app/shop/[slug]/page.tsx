import { shopService } from "@/lib/shop-service"
import { loadStorefrontSummary } from "@/lib/shop-commerce/storefront-summary"
import { buildShopItemListJsonLd } from "@/lib/shop-commerce/price-table"
import { shopCanonicalBase, shopRequestContext } from "@/lib/seo/shop-canonical"
import { SITE_URL } from "@/lib/seo/site"
import { showsPoweredByFooter } from "@/lib/seo/site-kind"
import ShopStorefront from "./storefront-client"
import { StorefrontSummary } from "./storefront-summary"
import { PoweredByFooter } from "./powered-by-footer"

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
  const shop = await shopService.getShopBySlug(slug).catch(() => null)

  if (!shop) {
    return <ShopStorefront initialLogoUrl={null} initialShopName={null} />
  }

  const [summary, { domainConfig, siteKind }] = await Promise.all([
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
  // The breadcrumb's first crumb is the DATAGOD homepage, so it only goes on
  // <shop>.datagod.store; custom domains are white-labelled.
  const breadcrumb =
    siteKind === "shop"
      ? {
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
            { "@type": "ListItem", position: 2, name: shop.shop_name, item: url },
          ],
        }
      : null

  const showPoweredBy = showsPoweredByFooter(siteKind)

  return (
    <>
      {breadcrumb && <JsonLd data={breadcrumb} />}
      {itemList && <JsonLd data={itemList} />}
      <ShopStorefront
        initialLogoUrl={shop.logo_url ?? null}
        initialShopName={shop.shop_name ?? null}
        showPoweredBy={showPoweredBy}
        serverSummary={
          <StorefrontSummary
            shopName={shop.shop_name}
            description={shop.description}
            logoUrl={shop.logo_url}
            table={summary?.table ?? null}
            showPrices={sellsData}
            whatsappLink={summary?.whatsappLink ?? null}
            accentColor={shop.custom_color}
            footer={showPoweredBy ? <PoweredByFooter /> : null}
          />
        }
      />
    </>
  )
}
