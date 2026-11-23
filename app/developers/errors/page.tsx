import type { Metadata } from "next"
import { ErrorGuideList } from "@/components/developer/docs/ErrorGuideList"
import { buildErrorGuide } from "@/lib/api-v2/docs/error-guide"
import { docPageMetadata } from "@/lib/api-v2/docs/page-meta"

export const metadata: Metadata = docPageMetadata("errors")

export default function ErrorsPage() {
  const entries = buildErrorGuide()
  return (
    <>
      <header className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-6 lg:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Developer API · v2</p>
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Errors</h1>
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">
          Every documented error, what it means and what to do about it. {entries.length} entries, grouped by cause.
        </p>
      </header>
      <ErrorGuideList entries={entries} />
    </>
  )
}
