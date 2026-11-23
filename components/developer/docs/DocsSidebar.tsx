// components/developer/docs/DocsSidebar.tsx
"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { DOCS_HEADER_PX, activeNavHref, type NavGroup, type NavItem } from "@/lib/api-v2/docs/nav"
import { useScrollSpy } from "./useScrollSpy"

/** Files and downloads are plain links; everything else is a docs page. */
const isFileHref = (href: string) => /\.json$|\/postman\//.test(href)

function NavTree({
  nav,
  activeHref,
  activeSectionId,
  onNavigate,
}: {
  nav: NavGroup[]
  activeHref: string
  activeSectionId: string
  onNavigate?: () => void
}) {
  const linkClass = (active: boolean) =>
    cn(
      "relative flex min-h-10 items-center rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active
        ? "bg-primary/10 font-semibold text-primary before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-primary"
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
    )

  const renderItem = (item: NavItem) => {
    const active = item.href === activeHref
    return (
      <li key={item.href}>
        {isFileHref(item.href) ? (
          <a href={item.href} className={linkClass(false)}>
            {item.label}
          </a>
        ) : (
          <Link href={item.href} aria-current={active ? "page" : undefined} onClick={onNavigate} className={linkClass(active)}>
            {item.label}
          </Link>
        )}
        {active && item.sections && item.sections.length > 0 && (
          <ul className="my-1 ml-3 space-y-0.5 border-l border-border pl-2">
            {item.sections.map((s) => (
              <li key={s.id}>
                <Link
                  href={s.href}
                  onClick={onNavigate}
                  aria-current={s.id === activeSectionId ? "location" : undefined}
                  className={cn(
                    "flex min-h-9 items-center rounded-md px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    s.id === activeSectionId ? "bg-primary/5 font-semibold text-primary" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <nav aria-label="Developer docs" className="space-y-5">
      {nav.map((g) => (
        <div key={g.label}>
          <p className="px-3 pb-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{g.label}</p>
          <ul className="space-y-0.5">{g.items.map(renderItem)}</ul>
        </div>
      ))}
    </nav>
  )
}

/**
 * Renders (as direct children of the layout grid) a sticky phone bar with the "Docs menu" sheet and `children`
 * (the search button), and from `lg` up a sticky side nav. The active page's sections nest under it and follow the scroll.
 */
export function DocsSidebar({ nav, children }: { nav: NavGroup[]; children?: React.ReactNode }) {
  const pathname = usePathname() ?? "/developers"
  const activeHref = activeNavHref(pathname)
  const [open, setOpen] = useState(false)
  const activeItem = useMemo(() => nav.flatMap((g) => g.items).find((i) => i.href === activeHref), [nav, activeHref])
  const ids = useMemo(() => activeItem?.sections?.map((s) => s.id) ?? [], [activeItem])
  const [activeSectionId] = useScrollSpy(ids, DOCS_HEADER_PX)

  return (
    <>
      <div className="sticky top-[64px] z-30 -mx-4 mb-4 flex items-center gap-2 border-b border-border bg-card/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-card/85 sm:-mx-6 sm:px-6 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 lg:hidden"
        >
          <Menu className="size-4" aria-hidden />
          Docs menu
        </button>
        <div className="min-w-0 flex-1">{children}</div>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[85%] gap-0 overflow-y-auto p-0 sm:max-w-sm">
          <SheetHeader className="border-b border-border px-5 pb-4 pt-5">
            <SheetTitle>Docs menu</SheetTitle>
            <SheetDescription>Pages and sections of the developer API docs.</SheetDescription>
          </SheetHeader>
          <div className="p-3">
            <NavTree nav={nav} activeHref={activeHref} activeSectionId={activeSectionId} onNavigate={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      <aside className="hidden lg:block lg:self-start lg:sticky lg:top-[88px] lg:max-h-[calc(100vh-112px)] lg:overflow-y-auto lg:pb-6 lg:pr-1">
        <NavTree nav={nav} activeHref={activeHref} activeSectionId={activeSectionId} />
      </aside>
    </>
  )
}
