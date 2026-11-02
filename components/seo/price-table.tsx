import type { PriceGroup } from "@/lib/seo/data-prices"
import { formatCedis } from "@/lib/seo/live-facts"
import { BuyButton } from "./buy-button"

const CARD = "rounded-xl border border-white/60 dark:border-white/5 bg-card clay"

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

function Table({ group, caption }: { group: PriceGroup; caption: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        {caption && <caption className="mb-2 text-left text-xs text-muted-foreground">{caption}</caption>}
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">Bundle</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">Price</th>
            <th scope="col" className="py-2 text-right font-medium">Price per GB</th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((r) => (
            <tr key={r.size} className="border-b border-border/60 last:border-0">
              <th scope="row" className="py-2.5 pr-4 font-medium text-foreground">{r.label}</th>
              <td className="py-2.5 pr-4 text-right font-semibold text-primary">{formatCedis(r.price)}</td>
              <td className="py-2.5 text-right text-muted-foreground">{r.perGb !== null ? formatCedis(r.perGb) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Live price list for a network data page. Renders nothing when there are no rows. */
export function PriceTable({ name, groups, loadedAt }: { name: string; groups: PriceGroup[]; loadedAt: string }) {
  const shown = groups.filter((g) => g.rows.length > 0)
  if (shown.length === 0) return null
  const date = updatedOn(loadedAt)
  const caption = date ? `Prices updated ${date}` : null
  const multi = shown.length > 1

  return (
    <section aria-labelledby="prices-heading" className="mt-16">
      <h2 id="prices-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        {name} prices
      </h2>
      <div className={`mt-6 grid grid-cols-1 gap-4 ${multi ? "lg:grid-cols-2" : "lg:max-w-3xl"}`}>
        {shown.map((g) => (
          <div key={g.network} className={`${CARD} p-5 sm:p-6`}>
            {multi && <h3 className="mb-3 font-display text-lg font-semibold text-foreground">{g.network}</h3>}
            <Table group={g} caption={caption} />
          </div>
        ))}
      </div>
      <div className="mt-6">
        <BuyButton />
      </div>
    </section>
  )
}
