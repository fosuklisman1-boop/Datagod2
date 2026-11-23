import Link from "next/link"
import Image from "next/image"
import { DocsSidebar } from "@/components/developer/docs/DocsSidebar"
import { DocsSearch } from "@/components/developer/docs/DocsSearch"
import { buildDocsNav } from "@/lib/api-v2/docs/nav"

// Static: no request headers are read here, so every docs page can be statically generated.
const NAV = buildDocsNav()

export default function DevelopersLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/40">
      {/*
        globals.css sets overflow-x:hidden on html AND body. With html non-visible, body's own value applies and
        makes body a scroll container that never scrolls, which breaks position:sticky and the docs scroll-spy
        (IntersectionObserver clips to it). Releasing body here keeps html's overflow-x:hidden (which still guards
        horizontal overflow) while letting the viewport be the scroller. Scoped to this page: the tag unmounts on navigation.
      */}
      <style>{"body{overflow-x:visible !important}"}</style>
      <header className="sticky top-0 z-40 h-[64px] border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label="DATAGOD home">
            <Image src="/icons/icon-512x512.png" alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-full object-cover" />
            <span className="truncate text-base font-bold tracking-tight text-foreground">DATAGOD</span>
            <span className="hidden rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-bold text-primary sm:inline">Developers</span>
          </Link>
          <div className="flex items-center gap-3">
            <div className="hidden w-64 lg:block">
              <DocsSearch />
            </div>
            <nav aria-label="Site" className="flex items-center gap-1 sm:gap-2">
              <Link
                href="/dashboard/developer"
                className="inline-flex min-h-10 items-center rounded-xl px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Dashboard
              </Link>
              <Link
                href="/auth/login?redirect=/dashboard/developer"
                className="inline-flex min-h-10 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
              >
                Log in
              </Link>
            </nav>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6 lg:px-8">
        <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-8 lg:pt-8">
          <DocsSidebar nav={NAV}>
            <DocsSearch />
          </DocsSidebar>
          <main className="min-w-0 space-y-6">{children}</main>
        </div>
      </div>
    </div>
  )
}
