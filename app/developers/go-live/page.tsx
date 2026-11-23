import Link from "next/link"
import type { Metadata } from "next"
import { Callout } from "@/components/developer/docs/Callout"
import { GO_LIVE_STEPS } from "@/lib/api-v2/docs/go-live"
import { docPageMetadata } from "@/lib/api-v2/docs/page-meta"

export const metadata: Metadata = docPageMetadata("go-live")

export default function GoLivePage() {
  return (
    <>
      <header className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-6 lg:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Developer API · v2</p>
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Go live</h1>
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">
          Move from a test key to a live key in nine steps. A live key waits for admin approval before it works.
        </p>
      </header>

      <Callout tone="info" title="Replacing a live key is safe">
        Your current live key keeps working until the new one is approved, and stops at that moment.
      </Callout>

      <ol className="space-y-4">
        {GO_LIVE_STEPS.map((step, i) => (
          <li key={step.id} id={step.id} className="flex scroll-mt-24 gap-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground ring-4 ring-primary/10"
            >
              {i + 1}
            </span>
            <div className="min-w-0 space-y-2">
              <h2 className="text-lg font-bold tracking-tight text-foreground">{step.title}</h2>
              <p className="text-sm leading-7 text-foreground/85">{step.body}</p>
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                {step.links.map((l) => (
                  <Link key={l.href + l.label} href={l.href} className="text-sm font-semibold text-primary underline-offset-4 hover:underline">
                    {l.label}
                  </Link>
                ))}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}
