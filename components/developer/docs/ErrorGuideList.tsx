"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { GROUP_ORDER, filterErrorGuide, type GuideError } from "@/lib/api-v2/docs/error-guide"

const chip = (status: number) =>
  cn(
    "inline-flex min-w-[3rem] items-center justify-center rounded-md px-2 py-0.5 font-mono text-xs font-bold",
    status >= 500 ? "bg-rose-100 text-rose-800" : status >= 400 ? "bg-amber-100 text-amber-900" : "bg-primary/10 text-primary",
  )

/** Searchable, grouped error guide. Every entry is an anchor target (id = entry.anchor). */
export function ErrorGuideList({ entries }: { entries: GuideError[] }) {
  const [query, setQuery] = useState("")
  const shown = useMemo(() => filterErrorGuide(entries, query), [entries, query])
  const groups = GROUP_ORDER.filter((g) => shown.some((e) => e.group === g))

  return (
    <div className="space-y-6">
      <label className="relative block">
        <span className="sr-only">Search errors</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by status, code or message"
          className="h-11 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      {shown.length === 0 && (
        <p className="rounded-xl border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          No matching errors. Try a status number, an error code such as REFERENCE_REUSED, or part of the message.
        </p>
      )}

      {groups.map((group) => (
        <section key={group} aria-label={group} className="space-y-3">
          <h2 className="text-lg font-bold tracking-tight text-foreground">{group}</h2>
          <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
            {shown
              .filter((e) => e.group === group)
              .map((e) => (
                <article
                  key={e.anchor}
                  id={e.anchor}
                  className="min-w-0 scroll-mt-24 space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={chip(e.status)}>{e.status}</span>
                    {e.code && <code className="break-all font-mono text-sm font-semibold text-foreground">{e.code}</code>}
                  </div>
                  <ul className="space-y-1 text-sm text-foreground/80">
                    {e.messages.map((m) => (
                      <li key={m} className="break-words">&ldquo;{m}&rdquo;</li>
                    ))}
                  </ul>
                  <p className="text-sm leading-6 text-foreground/85">{e.meaning}</p>
                  <p className="text-sm leading-6 text-foreground">
                    <span className="font-semibold">What to do: </span>
                    {e.fix}
                  </p>
                  {e.appliesTo && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold">Applies to: </span>
                      {e.appliesTo}
                    </p>
                  )}
                  {e.endpoints.length > 0 && (
                    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-semibold">Seen on</span>
                      {e.endpoints.map((ep) => (
                        <Link key={ep.id} href={ep.href} className="font-mono text-primary underline-offset-2 hover:underline">
                          {ep.method} {ep.path}
                        </Link>
                      ))}
                    </p>
                  )}
                </article>
              ))}
          </div>
        </section>
      ))}
    </div>
  )
}
