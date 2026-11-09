import type { Metadata } from "next"
import type { JSX } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowRight, ChevronRight } from "lucide-react"
import { assertMainSite, absoluteUrl } from "@/lib/seo/site"
import { getPublishedGuide, publishedGuides, type Guide } from "@/lib/seo/guides"
import { getLiveFacts } from "@/lib/seo/live-facts"
import { buildArticleJsonLd, buildBreadcrumbJsonLd, buildFaqJsonLd } from "@/lib/seo/json-ld"
import { OG_IMAGE } from "@/lib/seo/page-meta"
import { JsonLd } from "./json-ld-script"
import { FaqSection } from "./faq-section"
import { RelatedProducts } from "./related-products"

const CARD = "rounded-xl border border-white/60 dark:border-white/5 bg-card clay"

function pageMetadata(path: string, title: string, description: string, type: "article" | "website"): Metadata {
  const url = absoluteUrl(path)
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type, siteName: "DATAGOD", url, title, description, images: [OG_IMAGE] },
    // Set explicitly so the root layout's twitter copy is not inherited.
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE] },
  }
}

/** 404s (main-site guard, unknown/unpublished slug) before any metadata is emitted. */
export async function guidePageMetadata(slug: string): Promise<Metadata> {
  await assertMainSite()
  const g: Guide | null = getPublishedGuide(slug)
  if (!g) notFound()
  return pageMetadata(`/guides/${g.slug}`, g.title, g.description, "article")
}

export function guideStaticParams(): { slug: string }[] {
  return publishedGuides().map((g) => ({ slug: g.slug }))
}

export async function hubMetadata(): Promise<Metadata> {
  await assertMainSite()
  if (publishedGuides().length === 0) notFound()
  return pageMetadata(
    "/guides",
    "DATAGOD Guides: Buying Data in Ghana | DATAGOD",
    "Simple how-to guides for buying data, airtime and more in Ghana with DATAGOD, written step by step so you can order with confidence.",
    "website",
  )
}

function Crumbs({ items }: { items: { name: string; path: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-8 text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((c, i) => (
          <li key={c.path} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
            {i < items.length - 1 ? (
              <Link href={c.path} className="hover:text-primary hover:underline">
                {c.name}
              </Link>
            ) : (
              <span aria-current="page" className="text-foreground">
                {c.name}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

export async function renderGuidesHub(): Promise<JSX.Element> {
  await assertMainSite()
  const guides = publishedGuides()
  if (guides.length === 0) notFound()
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Guides", path: "/guides" },
  ]
  return (
    <div className="min-h-screen bg-background">
      <JsonLd data={buildBreadcrumbJsonLd(crumbs)} />
      <div className="mx-auto max-w-6xl px-4 py-10 sm:py-16">
        <Crumbs items={crumbs} />
        <h1 className="font-display text-3xl font-bold text-foreground text-balance sm:text-5xl">DATAGOD guides</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          Simple, step-by-step guides for buying data in Ghana with DATAGOD.
        </p>
        <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {guides.map((g) => (
            <li key={g.slug}>
              <Link href={`/guides/${g.slug}`} className={`${CARD} group flex h-full flex-col p-5 transition-colors hover:border-primary/40`}>
                <span className="font-display font-semibold text-foreground">{g.h1}</span>
                <span className="mt-1 text-sm text-muted-foreground">{g.description}</span>
                <span className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-medium text-primary">
                  Read guide <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export async function renderGuidePage(slug: string): Promise<JSX.Element> {
  await assertMainSite()
  const g = getPublishedGuide(slug)
  if (!g) notFound()
  const facts = await getLiveFacts()
  const whatsapp = facts.products.whatsapp?.available === true
  const ussdMain = facts.products.ussd?.available === true ? facts.ussd.main : null
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Guides", path: "/guides" },
    { name: g.h1, path: `/guides/${g.slug}` },
  ]

  return (
    <div className="min-h-screen bg-background">
      <JsonLd data={[buildArticleJsonLd(g), buildBreadcrumbJsonLd(crumbs), buildFaqJsonLd(g.faqs)]} />
      <div className="mx-auto max-w-6xl px-4 py-10 sm:py-16">
        <Crumbs items={crumbs} />
        <article className="lg:max-w-3xl">
          <h1 className="font-display text-3xl font-bold text-foreground text-balance sm:text-5xl">{g.h1}</h1>
          <p className="mt-3 text-sm text-muted-foreground">Last updated {g.updated}</p>

          {g.sections.map((s) => (
            <section key={s.heading} className="mt-10">
              <h2 className="font-display text-2xl font-bold text-foreground sm:text-3xl">{s.heading}</h2>
              {s.paragraphs.map((para) => (
                <p key={para} className="mt-4 leading-relaxed text-muted-foreground">
                  {para}
                </p>
              ))}
              {s.steps && (
                <ol className={`${CARD} mt-6 list-decimal space-y-3 p-5 pl-9 text-foreground marker:font-semibold marker:text-primary`}>
                  {s.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              )}
            </section>
          ))}

          {(whatsapp || ussdMain) && (
            <section className="mt-10">
              <h2 className="font-display text-2xl font-bold text-foreground sm:text-3xl">Other ways to order</h2>
              {whatsapp && (
                <p className="mt-4 leading-relaxed text-muted-foreground">
                  Prefer chat? Message DATAGOD on WhatsApp, say the bundle and the number, then approve the MoMo prompt.{" "}
                  <Link href="/whatsapp" className="font-medium text-primary hover:underline">
                    How WhatsApp ordering works
                  </Link>
                </p>
              )}
              {ussdMain && (
                <p className="mt-4 leading-relaxed text-muted-foreground">
                  No internet? Dial <span className="font-mono font-medium text-foreground">{ussdMain}</span> on any phone, follow the menu and confirm the MoMo prompt.{" "}
                  <Link href="/ussd" className="font-medium text-primary hover:underline">
                    More about USSD ordering
                  </Link>
                </p>
              )}
            </section>
          )}
        </article>

        <FaqSection faqs={g.faqs} />
        <RelatedProducts keys={g.related} facts={facts} title="Check current prices" />

        <div className="mt-16 text-center text-sm text-muted-foreground">
          <Link href="/guides" className="text-primary hover:underline">All guides</Link>
          {" · "}
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
        </div>
      </div>
    </div>
  )
}
