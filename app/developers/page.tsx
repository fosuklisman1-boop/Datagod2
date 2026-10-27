import Link from "next/link"
import type { Metadata } from "next"
import { KeyRound } from "lucide-react"
import { DocsPage } from "@/components/developer/docs/DocsPage"
import { PostmanButtons } from "@/components/developer/docs/PostmanButtons"
import { v2DocsRegistry, V2_BASE_URL } from "@/lib/api-v2/docs/registry"

const TITLE = "Developer API | DATAGOD"
const DESCRIPTION =
  "Build on Datagod. Buy data bundles, airtime, utility bills and results checker vouchers, register AFA customers and send SMS from your own software, with cURL, Node.js, PHP and Python examples and a ready-made Postman collection."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/developers" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/developers", type: "website", siteName: "DATAGOD" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
}

/** Height in px of the sticky site header below (h-[64px], px not rem: globals.css scales the root font size on small screens). Passed to DocsPage so its bars sit under it. */
const HEADER_PX = 64

export default function DevelopersPage() {
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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/icon-512x512.png" alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
            <span className="truncate text-base font-bold tracking-tight text-foreground">DATAGOD</span>
            <span className="hidden rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-bold text-primary sm:inline">Developers</span>
          </Link>
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
      </header>

      <section className="border-b border-border bg-card">
        <div className="mx-auto max-w-6xl space-y-5 px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Developer API · v2</p>
          <h1 className="max-w-3xl text-3xl font-bold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
            Build on Datagod
          </h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            One JSON API for data bundles, airtime, utility bills, results checker vouchers, AFA registration and SMS. Test in the sandbox, then go live.
          </p>
          <div className="flex max-w-full items-center gap-2 overflow-x-auto rounded-xl border border-border bg-muted px-3 py-2 text-sm sm:w-fit">
            <span className="shrink-0 text-xs font-bold uppercase tracking-wider text-muted-foreground">Base URL</span>
            <code className="whitespace-nowrap font-mono text-foreground">{V2_BASE_URL}</code>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <PostmanButtons />
            <Link
              href="/dashboard/developer"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-2 text-sm font-semibold text-primary underline-offset-4 hover:underline"
            >
              <KeyRound className="size-4" aria-hidden />
              Get your API key
            </Link>
          </div>
        </div>
      </section>

      <main className="px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <DocsPage sections={v2DocsRegistry} compact stickyTop={HEADER_PX} />
      </main>
    </div>
  )
}
