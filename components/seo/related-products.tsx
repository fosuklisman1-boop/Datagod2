import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { availableEntries } from "@/lib/seo/page-meta"
import { formatCedis, type LiveFacts } from "@/lib/seo/live-facts"
import type { ProductKey } from "@/lib/seo/products"

/** Links to related product pages; products that are switched off are left out. */
export function RelatedProducts({
  keys,
  facts,
  title = "Related services",
}: {
  keys: ProductKey[]
  facts: LiveFacts
  title?: string
}) {
  const entries = availableEntries(keys, facts)
  if (entries.length === 0) return null
  return (
    <section aria-labelledby="related-heading" className="mt-16">
      <h2 id="related-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        {title}
      </h2>
      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((e) => {
          const from = facts.products[e.key]?.fromPrice
          const price = from != null ? formatCedis(from) : ""
          return (
            <li key={e.key}>
              <Link
                href={e.path}
                className="group flex h-full flex-col rounded-xl border border-white/60 dark:border-white/5 bg-card p-5 clay transition-colors hover:border-primary/40"
              >
                <span className="font-display font-semibold text-foreground">{e.name}</span>
                <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">{e.summary}</span>
                <span className="mt-auto flex items-center justify-between pt-4 text-sm">
                  <span className="text-muted-foreground">{price ? `From ${price}` : ""}</span>
                  <span className="inline-flex items-center gap-1 font-medium text-primary">
                    View <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
