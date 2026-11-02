import type React from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { formatCedis, type LiveFacts } from "@/lib/seo/live-facts"
import { tableColumns, type DataNet, type PriceRow } from "@/lib/seo/data-prices"
import { DATA_PAGE_COPY, dataPageParagraphs } from "@/lib/seo/data-page-copy"
import { availableEntries } from "@/lib/seo/page-meta"
import type { ProductKey } from "@/lib/seo/products"

const CARD = "rounded-xl border border-white/60 dark:border-white/5 bg-card clay"

const DATA_KEYS: readonly ProductKey[] = ["mtn-data", "telecel-data", "at-data"]

/**
 * Crawlable price table for one network; renders nothing when there are no rows (e.g. the read failed).
 * `heading` / `headingId` / `caption` / `children` let a page show several tables (the landing pages,
 * lib/seo/landing-pages.ts); the network pages use the defaults.
 */
export function DataPriceTable({
  network,
  rows,
  heading,
  headingId = "prices-heading",
  caption,
  children,
}: {
  network: DataNet
  rows: readonly PriceRow[]
  heading?: string
  headingId?: string
  caption?: string
  children?: React.ReactNode
}) {
  if (rows.length === 0) return null
  const copy = DATA_PAGE_COPY[network]
  const cols = tableColumns(rows)
  return (
    <section aria-labelledby={headingId} className="mt-16">
      <h2 id={headingId} className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        {heading ?? copy.tableHeading}
      </h2>
      <div className={`${CARD} mt-6 overflow-x-auto`}>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            {caption ?? `${network} data bundles on sale now, with the price you pay from your DATAGOD wallet in Ghana cedis`}
          </caption>
          <thead className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Bundle size</th>
              {cols.type && <th scope="col" className="px-4 py-3 font-medium">Type</th>}
              {cols.validity && <th scope="col" className="px-4 py-3 font-medium">Validity</th>}
              <th scope="col" className="px-4 py-3 text-right font-medium">Price</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.type}-${r.size}-${r.price}-${r.validity}-${i}`} className="border-b border-border last:border-0">
                <th scope="row" className="px-4 py-3 font-semibold text-foreground">{r.size}</th>
                {cols.type && <td className="px-4 py-3 text-muted-foreground">{r.type ?? ""}</td>}
                {cols.validity && <td className="px-4 py-3 text-muted-foreground">{r.validity ?? ""}</td>}
                <td className="px-4 py-3 text-right font-semibold text-foreground">{formatCedis(r.price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Standard prices from your wallet. Create a free account or log in to buy.
      </p>
      {children}
    </section>
  )
}

/** The unique long-form copy for one network page. */
export function DataNetworkCopy({ network, rows }: { network: DataNet; rows: readonly PriceRow[] }) {
  const copy = DATA_PAGE_COPY[network]
  return (
    <section aria-labelledby="about-heading" className="mt-16 max-w-3xl">
      <h2 id="about-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        {copy.aboutHeading}
      </h2>
      <div className="mt-6 space-y-4 text-base leading-relaxed text-muted-foreground">
        {dataPageParagraphs(network, rows).map((t) => (
          <p key={t}>{t}</p>
        ))}
      </div>
    </section>
  )
}

/** "Compare MTN / Telecel / AT data prices": links to the sibling network pages that are live. */
export function CompareNetworks({ current, facts }: { current: ProductKey; facts: LiveFacts }) {
  const entries = availableEntries(DATA_KEYS, facts)
  if (entries.filter((e) => e.key !== current).length === 0) return null
  return (
    <nav aria-labelledby="compare-heading" className="mt-16">
      <h2 id="compare-heading" className="font-display text-xl sm:text-2xl font-bold text-foreground">
        Compare {entries.map((e) => e.network).join(" / ")} data prices
      </h2>
      <ul className="mt-4 flex flex-wrap gap-3">
        {entries.map((e) =>
          e.key === current ? (
            <li key={e.key}>
              <span aria-current="page" className="inline-flex items-center rounded-full border border-primary bg-primary/10 px-4 py-2 text-sm font-semibold text-primary">
                {e.network} data prices
              </span>
            </li>
          ) : (
            <li key={e.key}>
              <Link
                href={e.path}
                className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 px-4 py-2 text-sm font-semibold text-primary transition-colors hover:bg-primary/10"
              >
                {e.network} data prices <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  )
}
