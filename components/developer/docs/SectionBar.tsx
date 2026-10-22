// components/developer/docs/SectionBar.tsx
"use client"

import { useRef, useState } from "react"
import { List } from "lucide-react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

export interface SectionLink {
  id: string
  label: string
  /** Optional group heading; consecutive links with the same group are listed under one heading. */
  group?: string
}

/** Smooth-scroll to a section anchor and record it in the URL hash without adding history entries. */
export function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: "smooth", block: "start" })
  history.replaceState(null, "", `#${id}`)
}

function NavList({ sections, activeId, onSelect }: { sections: SectionLink[]; activeId: string; onSelect: (id: string) => void }) {
  return (
    <ul className="space-y-0.5">
      {sections.map((s, i) => {
        const active = s.id === activeId
        const showGroup = s.group && s.group !== sections[i - 1]?.group
        return (
          <li key={s.id}>
            {showGroup && (
              <p className={cn("px-3 pb-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground", i > 0 && "pt-4")}>
                {s.group}
              </p>
            )}
            <a
              href={`#${s.id}`}
              aria-current={active ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault()
                onSelect(s.id)
              }}
              className={cn(
                "relative flex min-h-10 items-center rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-primary/10 font-semibold text-primary before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {s.label}
            </a>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Below `lg`: a sticky "SECTION: <label>" bar whose Contents button opens a sheet listing every section.
 * From `lg` up: a sticky side nav. Returns a fragment so both stick against the page column, not a wrapper.
 */
export function SectionBar({
  sections,
  activeId,
  onNavigate,
  navFooter,
}: {
  sections: SectionLink[]
  activeId: string
  onNavigate?: (id: string) => void
  navFooter?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const pending = useRef<string | null>(null)
  const active = sections.find((s) => s.id === activeId) ?? sections[0]

  const go = (id: string) => {
    onNavigate?.(id)
    scrollToSection(id)
  }

  return (
    <>
      <div className="sticky top-0 z-30 -mt-1 mb-5 pt-1 lg:hidden">
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card/95 py-2 pl-4 pr-2 shadow-md backdrop-blur supports-[backdrop-filter]:bg-card/85">
          <p className="min-w-0 truncate text-sm" aria-live="polite">
            <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Section:</span>{" "}
            <span className="font-bold text-foreground">{active?.label}</span>
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <List className="size-4" aria-hidden />
            Contents
          </button>
        </div>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-[85%] gap-0 overflow-y-auto p-0 sm:max-w-sm"
          onCloseAutoFocus={(e) => {
            // Scroll only after the sheet has closed and released its scroll lock.
            const id = pending.current
            if (!id) return
            e.preventDefault()
            pending.current = null
            requestAnimationFrame(() => go(id))
          }}
        >
          <SheetHeader className="border-b border-border px-5 pb-4 pt-5">
            <SheetTitle>Contents</SheetTitle>
            <SheetDescription>Jump to a section of the API reference.</SheetDescription>
          </SheetHeader>
          <nav aria-label="API reference sections" className="p-3">
            <NavList
              sections={sections}
              activeId={activeId}
              onSelect={(id) => {
                pending.current = id
                setOpen(false)
              }}
            />
          </nav>
        </SheetContent>
      </Sheet>

      <aside className="hidden lg:block lg:self-start lg:sticky lg:top-6">
        <nav aria-label="API reference sections" className="max-h-[calc(100dvh-3rem)] overflow-y-auto pb-6 pr-1">
          <p className="mb-3 px-3 text-xs font-semibold text-muted-foreground">On this page</p>
          <NavList sections={sections} activeId={activeId} onSelect={go} />
          {navFooter && <div className="mt-6 px-3">{navFooter}</div>}
        </nav>
      </aside>
    </>
  )
}
