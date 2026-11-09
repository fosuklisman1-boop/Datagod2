import { DATA_PAGE_COPY, dataPageParagraphs, type DataNet, type LiveCopyFacts } from "@/lib/seo/data-page-copy"
import { atTypeOf } from "@/lib/seo/data-prices"
import type { LiveFacts } from "@/lib/seo/live-facts"

/** What a network page's conditional copy depends on, read from the live price lists. */
export function liveCopyFacts(network: DataNet, facts: LiveFacts): LiveCopyFacts {
  const priced = (groups: LiveFacts["prices"][DataNet]) => groups.filter((g) => g.rows.length > 0)
  const types = priced(facts.prices[network])
    .map((g) => atTypeOf(g.network))
    .filter((t): t is "iShare" | "BigTime" => t !== null)
  return { types, noExpiry: priced(facts.nonExpiryPrices[network]).length > 0 }
}

/**
 * The unique long-form copy for one network page (lib/seo/data-page-copy.ts).
 * The price list itself is main's PriceTable (components/seo/price-table.tsx).
 */
export function DataNetworkCopy({ network, facts }: { network: DataNet; facts: LiveFacts }) {
  const copy = DATA_PAGE_COPY[network]
  return (
    <section aria-labelledby="about-heading" className="mt-16 max-w-3xl">
      <h2 id="about-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        {copy.aboutHeading}
      </h2>
      <div className="mt-6 space-y-4 text-base leading-relaxed text-muted-foreground">
        {dataPageParagraphs(network, liveCopyFacts(network, facts)).map((t) => (
          <p key={t}>{t}</p>
        ))}
      </div>
    </section>
  )
}
