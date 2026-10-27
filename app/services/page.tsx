import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, ChevronRight, Clock, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { assertMainSite, absoluteUrl } from "@/lib/seo/site"
import { REFUND_LINE, SPEED_LINE } from "@/lib/seo/products"
import { formatCedis, getLiveFacts } from "@/lib/seo/live-facts"
import { buildBreadcrumbJsonLd } from "@/lib/seo/json-ld"
import { OG_IMAGE } from "@/lib/seo/page-meta"
import { buildItemListJsonLd, groupAvailableProducts } from "@/lib/seo/services-hub"
import { JsonLd } from "@/components/seo/json-ld-script"

const TITLE = "All DATAGOD Services: Data, Airtime, Bills & More | DATAGOD"
const DESCRIPTION =
  "Everything DATAGOD offers in Ghana in one place: data bundles, airtime, bill payments, results checkers and tools for resellers. Pay with MoMo or card."

const CARD = "rounded-xl border border-white/60 dark:border-white/5 bg-card clay"

export async function generateMetadata(): Promise<Metadata> {
  await assertMainSite()
  const url = absoluteUrl("/services")
  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: url },
    openGraph: { type: "website", siteName: "DATAGOD", url, title: TITLE, description: DESCRIPTION, images: [OG_IMAGE] },
  }
}

export default async function ServicesPage() {
  await assertMainSite()
  const facts = await getLiveFacts()
  const groups = groupAvailableProducts(facts)

  return (
    <div className="min-h-screen bg-background">
      <JsonLd
        data={[
          buildItemListJsonLd(groups),
          buildBreadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "All services", path: "/services" },
          ]),
        ]}
      />
      <div className="mx-auto max-w-6xl px-4 py-10 sm:py-16">
        <nav aria-label="Breadcrumb" className="mb-8 text-sm text-muted-foreground">
          <ol className="flex flex-wrap items-center gap-1">
            <li className="flex items-center gap-1">
              <Link href="/" className="hover:text-primary hover:underline">Home</Link>
            </li>
            <li className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              <span aria-current="page" className="text-foreground">All services</span>
            </li>
          </ol>
        </nav>

        <header className="max-w-3xl">
          <h1 className="font-display text-3xl font-bold text-foreground text-balance sm:text-5xl">
            All DATAGOD services
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            Buy data, airtime and more for yourself or anyone in Ghana, or start your own reselling business. Pay with
            Mobile Money (MoMo) or card through Paystack, or from your DATAGOD wallet.
          </p>
          <div className="mt-6 flex flex-col gap-2 text-sm text-foreground">
            <span className="flex items-start gap-3">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              {SPEED_LINE}
            </span>
            <span className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              {REFUND_LINE}
            </span>
          </div>
        </header>

        {groups.map((g) => (
          <section key={g.group} id={g.anchor} aria-labelledby={`${g.anchor}-heading`} className="mt-14 scroll-mt-24">
            <h2 id={`${g.anchor}-heading`} className="font-display text-2xl sm:text-3xl font-bold text-foreground">
              {g.label}
            </h2>
            <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map((p) => {
                const from = facts.products[p.key]?.fromPrice
                const price = from != null ? formatCedis(from) : ""
                return (
                  <li key={p.key}>
                    <Link
                      href={p.path}
                      className={`${CARD} group flex h-full flex-col p-5 transition-colors hover:border-primary/40`}
                    >
                      <span className="font-display font-semibold text-foreground">{p.name}</span>
                      <span className="mt-1 line-clamp-3 text-sm text-muted-foreground">{p.summary}</span>
                      {price && <span className="mt-3 text-sm font-medium text-foreground">From {price}</span>}
                      <span className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-medium text-primary">
                        Learn more{" "}
                        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}

        <section className={`${CARD} mt-16 p-6 text-center sm:p-10`}>
          <h2 className="font-display text-2xl font-bold text-foreground sm:text-3xl">Ready to get started?</h2>
          <p className="mt-2 text-muted-foreground">Create a free account and place your first order in minutes.</p>
          <div className="mt-6 flex justify-center">
            <Button asChild size="lg" className="w-full gap-2 sm:w-auto">
              <Link href="/auth/signup">
                Get started <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/auth/login" className="font-medium text-primary hover:underline">
              Log in
            </Link>
          </p>
        </section>

        <div className="mt-16 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
        </div>
      </div>
    </div>
  )
}
