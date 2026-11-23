import type { Metadata } from "next"
import { changelogAt } from "@/lib/api-v2/docs/changelog"
import { docPageMetadata } from "@/lib/api-v2/docs/page-meta"
import { cn } from "@/lib/utils"

export const metadata: Metadata = docPageMetadata("changelog")

// The v1 retirement entry flips from scheduled to released at 2026-11-30 00:00 GMT.
export const revalidate = 3600

export default function ChangelogPage() {
  return (
    <>
      <header className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-6 lg:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Developer API · v2</p>
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Changelog</h1>
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">What changed in the API and when, newest first.</p>
      </header>
      <ol className="space-y-4">
        {changelogAt().map((c) => (
          <li key={c.date + c.title} className="min-w-0 space-y-2 rounded-2xl border border-border bg-card p-4 sm:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <time dateTime={c.date} className="font-mono text-sm font-semibold text-muted-foreground">
                {c.date}
              </time>
              <span
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-bold",
                  c.status === "scheduled" ? "bg-amber-100 text-amber-900" : "bg-primary/10 text-primary",
                )}
              >
                {c.status === "scheduled" ? "Scheduled" : "Released"}
              </span>
            </div>
            <h2 className="text-lg font-bold tracking-tight text-foreground">{c.title}</h2>
            <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-foreground/85">
              {c.items.map((it) => (
                <li key={it}>{it}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </>
  )
}
