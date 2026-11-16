import Link from "next/link"
import { ArrowRight } from "lucide-react"
import type { LandingEntry } from "@/lib/seo/landing-pages"

/**
 * Links to landing pages (lib/seo/landing-pages.ts). Callers pass only live
 * ("ok") entries: availableLandings() / landingsForProduct().
 */
export function RelatedGuides({
  entries,
  title = "Guides and price lists",
  headingId = "guides-heading",
}: {
  entries: readonly LandingEntry[]
  title?: string
  headingId?: string
}) {
  if (entries.length === 0) return null
  return (
    <nav aria-labelledby={headingId} className="mt-16">
      <h2 id={headingId} className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        {title}
      </h2>
      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((e) => (
          <li key={e.key}>
            <Link
              href={e.path}
              className="group flex h-full flex-col rounded-xl border border-white/60 dark:border-white/5 bg-card p-5 clay transition-colors hover:border-primary/40"
            >
              <span className="font-display font-semibold text-foreground">{e.name}</span>
              <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">{e.description}</span>
              <span className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-medium text-primary">
                Read more <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
