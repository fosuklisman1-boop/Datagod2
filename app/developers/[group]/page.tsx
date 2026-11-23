import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { DocsPage } from "@/components/developer/docs/DocsPage"
import { v2DocsRegistry } from "@/lib/api-v2/docs/registry"
import { DOC_PAGES, sectionsForPage } from "@/lib/api-v2/docs/pages"
import { docPageMetadata } from "@/lib/api-v2/docs/page-meta"
import { DOCS_HEADER_PX } from "@/lib/api-v2/docs/nav"

export const dynamicParams = false

export function generateStaticParams() {
  return DOC_PAGES.map((p) => ({ group: p.slug }))
}

type Props = { params: Promise<{ group: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { group } = await params
  if (!DOC_PAGES.some((p) => p.slug === group)) notFound()
  return docPageMetadata(group)
}

export default async function DeveloperGroupPage({ params }: Props) {
  const { group } = await params
  const page = DOC_PAGES.find((p) => p.slug === group)
  if (!page) notFound()
  return (
    <>
      <header className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-6 lg:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Developer API · v2</p>
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">{page.title}</h1>
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">{page.description}</p>
      </header>
      <DocsPage sections={sectionsForPage(v2DocsRegistry, page.slug)} compact showSectionNav={false} tryIt endpointLayout="split" stickyTop={DOCS_HEADER_PX} />
    </>
  )
}
