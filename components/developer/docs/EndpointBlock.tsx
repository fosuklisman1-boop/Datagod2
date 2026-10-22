// components/developer/docs/EndpointBlock.tsx
import { Gauge, KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"
import type { V2Endpoint } from "@/lib/api-v2/docs/registry"
import { buildSamples } from "@/lib/api-v2/docs/samples"
import { CodeBlock, CodeTabs } from "./CodeTabs"
import { ParamTable } from "./ParamTable"
import { InlineCode, RichText } from "./RichText"

const KEY_LABEL: Record<NonNullable<V2Endpoint["keyType"]>, string> = {
  standard: "Standard key",
  commission: "Commission Services key",
  sms: "SMS key",
}

const METHOD_CLS: Record<V2Endpoint["method"], string> = {
  GET: "bg-sky-600 text-white",
  POST: "bg-emerald-600 text-white",
}

/** Status badge colours: auth/permission rose, rate limit amber, server/upstream slate, other client errors orange. */
function statusCls(status: number): string {
  if (status === 401 || status === 403) return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
  if (status === 429) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  if (status >= 500) return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300"
  return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300"
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{children}</h4>
}

function Chip({ icon: Icon, children }: { icon: typeof KeyRound; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-2.5 py-1 text-xs font-medium text-foreground/80 dark:bg-white/5">
      <Icon className="size-3.5 text-primary" aria-hidden />
      {children}
    </span>
  )
}

const json = (v: unknown) => JSON.stringify(v, null, 2)

export function EndpointBlock({ endpoint: ep }: { endpoint: V2Endpoint }) {
  const samples = buildSamples(ep)
  const name = `${ep.method} ${ep.path}`

  return (
    <article
      id={`endpoint-${ep.id}`}
      aria-label={name}
      className="scroll-mt-24 space-y-6 rounded-2xl border border-border bg-background/60 p-4 sm:p-6 dark:bg-black/20"
    >
      <header className="space-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className={cn("rounded-md px-2 py-1 font-mono text-xs font-bold tracking-wide", METHOD_CLS[ep.method])}>
            {ep.method}
          </span>
          <h3 className="min-w-0 break-all font-mono text-base font-semibold text-foreground sm:text-lg">{ep.path}</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip icon={KeyRound}>{ep.keyType ? KEY_LABEL[ep.keyType] : "Any active key"}</Chip>
          <Chip icon={Gauge}>{ep.rateLimit}</Chip>
        </div>
        <p className="text-sm leading-6 text-foreground/85 sm:text-[15px] sm:leading-7">
          <RichText text={ep.summary} />
        </p>
      </header>

      {ep.params.length > 0 && (
        <section className="space-y-2.5">
          <Heading>Parameters</Heading>
          <ParamTable params={ep.params} />
        </section>
      )}

      {ep.requestExample !== null && (
        <section className="space-y-2.5">
          <Heading>Request body</Heading>
          <CodeBlock code={json(ep.requestExample)} title="JSON" copyLabel={`${name} request body`} />
        </section>
      )}

      <section className="space-y-2.5">
        <Heading>Success response</Heading>
        <CodeBlock code={json(ep.successExample)} title="JSON · 200 OK" copyLabel={`${name} success response`} />
      </section>

      {ep.errors.length > 0 && (
        <section className="space-y-2.5">
          <Heading>Errors</Heading>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {ep.errors.map((e, i) => (
              <li key={i} className="flex items-start gap-3 px-4 py-3">
                <span className={cn("mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-xs font-bold", statusCls(e.status))}>
                  {e.status}
                </span>
                <span className="min-w-0 text-sm leading-6 text-foreground/85">{e.message}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-5 text-muted-foreground">
            Every error uses the envelope{" "}
            <InlineCode>{'{ "success": false, "error": { "code": <number>, "message": "<text>" } }'}</InlineCode>, where code
            repeats the HTTP status.
          </p>
        </section>
      )}

      {ep.notes.length > 0 && (
        <section className="space-y-2.5">
          <Heading>Notes</Heading>
          <ul className="space-y-2.5 rounded-xl bg-muted/70 p-4 dark:bg-white/[0.04]">
            {ep.notes.map((n, i) => (
              <li key={i} className="flex gap-2.5 text-sm leading-6 text-foreground/85">
                <span aria-hidden className="font-bold text-primary">→</span>
                <span className="min-w-0">
                  <RichText text={n} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <Heading>Code sample</Heading>
        <CodeTabs samples={samples} label={`for ${name}`} />
      </section>
    </article>
  )
}
