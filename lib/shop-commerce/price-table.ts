// Pure shaping for the server-rendered storefront price table and its JSON-LD
// (app/shop/[slug]/page.tsx). No I/O: the packages come from
// loadPublicShopPackages (lib/shop-commerce/public-packages.ts), the same
// loader the storefront API uses.

// Same ordering as the storefront's own size sort (and lib/shop-commerce/pricing.ts
// sizeToMb, which can't be imported here: that module builds a Supabase client on load).
function sizeToMb(size: string): number {
  const m = size.trim().match(/(\d+(?:\.\d+)?)\s*(MB|GB|TB)/i)
  if (!m) {
    const n = parseFloat(size)
    return isNaN(n) ? 0 : n * 1024
  }
  const v = parseFloat(m[1])
  const unit = m[2].toUpperCase()
  return unit === "MB" ? v : unit === "TB" ? v * 1024 * 1024 : v * 1024
}

export interface PriceTableRow {
  id: string
  /** e.g. "2GB", as the interactive storefront labels it. */
  label: string
  /** Selling price in GHS, or null when it can't be guaranteed to match checkout. */
  price: number | null
  description: string | null
}

export interface PriceTableNetwork {
  network: string
  rows: PriceTableRow[]
}

export interface PriceTable {
  networks: PriceTableNetwork[]
  /** True when at least one row carries a price. */
  priced: boolean
}

/** The storefront shows a bare size ("2") as "2GB"; anything already labelled is kept. */
export function bundleLabel(size: unknown): string {
  const s = String(size ?? "").trim()
  if (!s) return ""
  return /^\d+(\.\d+)?$/.test(s) ? `${s}GB` : s
}

function finitePrice(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v)
  // Not rounded here: the page formats it with toFixed(2), exactly as the client does.
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Groups the storefront's packages by network (in first-seen order, like the
 * client's network picker) and sorts each network by bundle size. A row's price
 * is the API's selling_price, kept only when its id is in `exactPriceIds`.
 */
export function buildShopPriceTable(packages: readonly any[], exactPriceIds: ReadonlySet<string>): PriceTable {
  const byNetwork = new Map<string, PriceTableRow[]>()
  const sizes = new Map<string, number>()

  for (const item of packages) {
    const pkg = item?.packages
    const network = typeof pkg?.network === "string" ? pkg.network.trim() : ""
    if (!network || item?.is_available === false) continue
    const id = String(item.id)
    const label = bundleLabel(pkg.size)
    if (!label) continue
    const price = exactPriceIds.has(id) ? finitePrice(item.selling_price) : null
    const row: PriceTableRow = {
      id,
      label,
      price,
      description: typeof pkg.description === "string" && pkg.description.trim() ? pkg.description.trim() : null,
    }
    sizes.set(id, sizeToMb(String(pkg.size ?? "")))
    const rows = byNetwork.get(network) ?? []
    rows.push(row)
    byNetwork.set(network, rows)
  }

  const networks = [...byNetwork.entries()].map(([network, rows]) => ({
    network,
    rows: [...rows].sort((a, b) => (sizes.get(a.id) ?? 0) - (sizes.get(b.id) ?? 0)),
  }))
  return { networks, priced: networks.some((n) => n.rows.some((r) => r.price != null)) }
}

/** "GH₵12.50", the storefront's own price format. */
export function formatShopPrice(price: number): string {
  return `GH₵${price.toFixed(2)}`
}

/**
 * schema.org ItemList of Products for a storefront. Only priced rows are listed
 * (a Product offer without a price is invalid for rich results); null when
 * nothing is priced.
 */
export function buildShopItemListJsonLd(input: {
  shopName: string
  url: string
  table: PriceTable
  orderingEnabled: boolean
}): Record<string, unknown> | null {
  const items = input.table.networks.flatMap((n) =>
    n.rows
      .filter((r) => r.price != null)
      .map((r) => ({ network: n.network, row: r })),
  )
  if (items.length === 0) return null
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${input.shopName} data bundles`,
    itemListElement: items.map(({ network, row }, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Product",
        name: `${row.label} ${network} Data Bundle`,
        description: row.description || `${row.label} ${network} data bundle from ${input.shopName}`,
        offers: {
          "@type": "Offer",
          price: row.price!.toFixed(2),
          priceCurrency: "GHS",
          availability: input.orderingEnabled ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          url: input.url,
          seller: { "@type": "Organization", name: input.shopName },
        },
      },
    })),
  }
}
