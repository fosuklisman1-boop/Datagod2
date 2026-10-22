// components/developer/docs/DocsPage.tsx
"use client"

import { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { V2_BASE_URL, type V2DocSection } from "@/lib/api-v2/docs/registry"
import { Callout } from "./Callout"
import { EndpointBlock } from "./EndpointBlock"
import { InlineCode, RichText } from "./RichText"
import { SectionBar, type SectionLink } from "./SectionBar"
import { StepList } from "./StepList"

export const DOC_GROUP_LABELS: Record<V2DocSection["group"], string> = {
  start: "Getting started",
  data: "Data & wallet",
  commission: "Commission services",
  results: "Results & AFA",
  sms: "SMS",
  sandbox: "Sandbox",
}

/** Highlights the section whose card crosses the band just below the sticky bar (IntersectionObserver scroll-spy). */
function useScrollSpy(ids: string[]): [string, (id: string) => void] {
  const [active, setActive] = useState(ids[0] ?? "")
  useEffect(() => {
    const visible = new Map<string, boolean>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting)
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
        const next = atBottom ? ids[ids.length - 1] : ids.find((id) => visible.get(id))
        if (next) setActive(next)
      },
      { rootMargin: "-96px 0px -55% 0px", threshold: 0 }
    )
    for (const id of ids) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [ids])
  return [active, setActive]
}

export function DocsPage({
  sections,
  top,
  compact = false,
  navFooter,
}: {
  sections: V2DocSection[]
  /** Rendered above the first section, e.g. a "Download Postman collection" button. */
  top?: React.ReactNode
  /** Tighter padding and no hero, for embedding inside the dashboard. */
  compact?: boolean
  /** Rendered under the desktop side nav. */
  navFooter?: React.ReactNode
}) {
  const links = useMemo<SectionLink[]>(
    () => sections.map((s) => ({ id: s.id, label: s.label, group: DOC_GROUP_LABELS[s.group] })),
    [sections]
  )
  const ids = useMemo(() => sections.map((s) => s.id), [sections])
  const [activeId, setActiveId] = useScrollSpy(ids)

  return (
    <div className={cn("mx-auto w-full max-w-6xl", !compact && "px-4 py-6 sm:px-6 lg:px-8 lg:py-10")}>
      {!compact && (
        <header className="mb-6 space-y-3 lg:mb-10 lg:pl-[272px]">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Developer API · v2</p>
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">API reference</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
            Base URL <InlineCode>{V2_BASE_URL}</InlineCode>. Every request is authenticated with an API key and returns JSON.
          </p>
        </header>
      )}

      <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-8">
        <SectionBar sections={links} activeId={activeId} onNavigate={setActiveId} navFooter={navFooter} />

        <div className="min-w-0 space-y-6">
          {top && <div className="flex flex-wrap items-center gap-3">{top}</div>}

          {sections.map((s) => (
            <section
              key={s.id}
              id={s.id}
              aria-labelledby={`${s.id}-title`}
              className="scroll-mt-24 space-y-5 rounded-2xl border border-white/60 bg-card p-4 clay dark:border-white/5 sm:p-6 lg:scroll-mt-8 lg:p-8"
            >
              <div className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">{DOC_GROUP_LABELS[s.group]}</p>
                <h2 id={`${s.id}-title`} className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                  {s.label}
                </h2>
              </div>

              {s.intro && (
                <p className="text-sm leading-7 text-foreground/80 sm:text-[15px]">
                  <RichText text={s.intro} />
                </p>
              )}

              {s.callouts?.map((c, i) => (
                <Callout key={i} tone={c.tone} title={c.title}>
                  <RichText text={c.body} />
                </Callout>
              ))}

              {s.steps && s.steps.length > 0 && (
                <div className="space-y-4 border-t border-border pt-5">
                  <h3 className="text-base font-bold text-foreground sm:text-lg">Step by step</h3>
                  <StepList steps={s.steps} />
                </div>
              )}

              {s.endpoints.length > 0 && (
                <div className="space-y-6">
                  {s.endpoints.map((ep) => (
                    <EndpointBlock key={ep.id} endpoint={ep} />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
