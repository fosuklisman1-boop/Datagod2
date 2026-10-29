import type { PriceGroups } from "@/lib/seo/data-prices"
import { buildComparison, COMPARE_NETWORKS } from "@/lib/seo/compare"
import { formatCedis } from "@/lib/seo/live-facts"
import { BuyButton } from "./buy-button"

const CARD = "rounded-xl border border-white/60 dark:border-white/5 bg-card clay"

const NETWORK_LABEL = { MTN: "MTN", Telecel: "Telecel", AT: "AT" } as const

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Accra",
  day: "numeric",
  month: "short",
  year: "numeric",
})

function updatedOn(loadedAt: string): string | null {
  const d = new Date(loadedAt)
  return Number.isNaN(d.getTime()) ? null : DATE_FORMAT.format(d)
}

/** Our own live prices across networks: best price per GB, then exact sizes side by side. */
export function Comparison({ prices, loadedAt }: { prices: PriceGroups; loadedAt: string }) {
  const { best, sizes } = buildComparison(prices)
  if (best.length === 0 && sizes.length === 0) return null
  const date = updatedOn(loadedAt)

  return (
    <section aria-labelledby="compare-heading" className="mt-16">
      <h2 id="compare-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        Our prices side by side
      </h2>
      {date && <p className="mt-2 text-sm text-muted-foreground">Prices updated {date}</p>}

      {best.length > 0 && (
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label="Lowest price per GB by network">
          {best.map((b) => (
            <li key={b.network} className={`${CARD} p-5`}>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">{NETWORK_LABEL[b.network]} lowest price per GB</div>
              <div className="mt-1 font-display text-3xl font-bold text-primary">{formatCedis(b.perGb)}</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {b.size} for {formatCedis(b.price)}
              </div>
            </li>
          ))}
        </ul>
      )}

      {sizes.length > 0 && (
        <div className={`${CARD} mt-6 p-5 sm:p-6 lg:max-w-3xl`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="mb-2 text-left text-xs text-muted-foreground">
                Price for the same bundle size. A dash means that size is not on offer.
              </caption>
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">Bundle</th>
                  {COMPARE_NETWORKS.map((n) => (
                    <th key={n} scope="col" className="py-2 pr-4 text-right font-medium last:pr-0">{NETWORK_LABEL[n]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sizes.map((s) => (
                  <tr key={s.gb} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="py-2.5 pr-4 font-medium text-foreground">{s.gb}GB</th>
                    {COMPARE_NETWORKS.map((n) => (
                      <td key={n} className="py-2.5 pr-4 text-right font-semibold text-primary last:pr-0">
                        {s.cells[n] !== null ? formatCedis(s.cells[n] as number) : <span className="font-normal text-muted-foreground">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-6">
        <BuyButton />
      </div>
    </section>
  )
}
