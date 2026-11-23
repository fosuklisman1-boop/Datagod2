import type { Metadata } from "next"
import { Download } from "lucide-react"
import { CodeBlock } from "@/components/developer/docs/CodeTabs"
import { PostmanButtons } from "@/components/developer/docs/PostmanButtons"
import { STARTER_KITS } from "@/lib/api-v2/docs/starter-kits"
import { docPageMetadata } from "@/lib/api-v2/docs/page-meta"

export const metadata: Metadata = docPageMetadata("starter-kits")

export default function StarterKitsPage() {
  return (
    <>
      <header className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-6 lg:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Developer API · v2</p>
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Starter kits</h1>
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">
          Single-file samples that read your balance, buy data safely and poll the order. They read the key from the DATAGOD_API_KEY
          environment variable and start with a test key.
        </p>
        <PostmanButtons />
      </header>

      {STARTER_KITS.map((kit) => (
        <section key={kit.id} id={kit.id} className="min-w-0 scroll-mt-24 space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-bold tracking-tight text-foreground">{kit.title}</h2>
              <p className="break-all font-mono text-sm text-muted-foreground">{kit.filename}</p>
            </div>
            <a
              href={`/developers/starter-kits/${kit.id}`}
              download
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              <Download className="size-4" aria-hidden />
              Download {kit.filename}
            </a>
          </div>
          <p className="text-sm text-foreground/85">
            Run: <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">{kit.runCommand}</code>
          </p>
          <CodeBlock code={kit.source} title={kit.title} copyLabel={`${kit.title} starter kit source`} />
        </section>
      ))}
    </>
  )
}
