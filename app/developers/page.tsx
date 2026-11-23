import Link from "next/link"
import type { Metadata } from "next"
import { KeyRound } from "lucide-react"
import { DocsPage } from "@/components/developer/docs/DocsPage"
import { PostmanButtons } from "@/components/developer/docs/PostmanButtons"
import { QuickStart } from "@/components/developer/docs/QuickStart"
import { v2DocsRegistry, V2_BASE_URL } from "@/lib/api-v2/docs/registry"
import { sectionsForPage } from "@/lib/api-v2/docs/pages"
import { docPageMetadata } from "@/lib/api-v2/docs/page-meta"
import { DOCS_HEADER_PX } from "@/lib/api-v2/docs/nav"
import { getProduct } from "@/lib/seo/products"
import { getLiveFacts } from "@/lib/seo/live-facts"
import { isMainSiteRequest } from "@/lib/seo/site"
import { RelatedProducts } from "@/components/seo/related-products"

export const metadata: Metadata = docPageMetadata()

export default async function DevelopersPage() {
  // Related row (sibling product pages), main site only, like /join and /bulk-sms.
  const [facts, mainSite] = await Promise.all([getLiveFacts(), isMainSiteRequest()])
  return (
    <>
      <section className="space-y-5 rounded-2xl border border-border bg-card p-5 sm:p-8 lg:p-10">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Developer API · v2</p>
        <h1 className="max-w-3xl text-3xl font-bold tracking-tight text-foreground sm:text-4xl lg:text-5xl">Build on Datagod</h1>
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
      </section>

      <QuickStart />

      <DocsPage sections={sectionsForPage(v2DocsRegistry, null)} compact showSectionNav={false} stickyTop={DOCS_HEADER_PX} />

      {mainSite && <RelatedProducts keys={getProduct("developers").related} facts={facts} />}
    </>
  )
}
