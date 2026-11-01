import type { Metadata } from "next"
import type { JSX } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Globe,
  Headset,
  MessageCircle,
  Phone,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { assertMainSite } from "@/lib/seo/site"
import { findProduct, REFUND_LINE, SPEED_LINE, type ProductEntry, type ProductGroup, type ProductKey } from "@/lib/seo/products"
import { formatCedis, getLiveFacts, LiveFactsUnavailableError, type LiveFacts, type ProductFacts } from "@/lib/seo/live-facts"
import { buildProductJsonLd, productCrumbs } from "@/lib/seo/json-ld"
import { buildProductMetadata, liveBillerEntries, pageAvailability } from "@/lib/seo/page-meta"
import { JsonLd } from "./json-ld-script"
import { FaqSection } from "./faq-section"
import { RelatedProducts } from "./related-products"
import { RelatedGuides } from "./related-guides"
import { landingsForProduct } from "@/lib/seo/landing-pages"
import { CompareNetworks, DataNetworkCopy, DataPriceTable } from "./data-network-sections"

const GROUP_LABEL: Record<ProductGroup, string> = {
  data: "Data bundles",
  airtime: "Airtime",
  bills: "Bill payments",
  education: "Education",
  business: "For business",
  channels: "Ways to order",
}

const PARTS_LABEL: Record<ProductGroup, string> = {
  data: "Networks",
  airtime: "Networks",
  bills: "Billers",
  education: "Exams",
  business: "Available",
  channels: "Available",
}

const CARD = "rounded-xl border border-white/60 dark:border-white/5 bg-card clay"

/**
 * Availability policy for a registry product page (H3):
 *  - not in the registry (retired for good): 404
 *  - facts failed to load (on/off unknown): throw -> 5xx, never cached
 *  - switched off by the admin: 200 with a "temporarily unavailable" notice
 *  - on: the normal page
 *
 * Why the status is decided in the root layout too: app/loading.tsx wraps
 * every page in Suspense, so by the time this page (or its streamed
 * metadata) runs, Next has already sent a 200 shell; a throw here only shows
 * the error boundary. The root layout sits outside that boundary, so
 * assertProductFactsLoaded() (lib/seo/product-status.ts) throws there for a
 * full page load and Next answers 500. The throws below cover client-side
 * navigation, where the root layout is not re-rendered.
 */
async function resolveProductPage(key: ProductKey): Promise<{ p: ProductEntry; facts: LiveFacts; off: boolean }> {
  // 404s on custom domains / shop hosts before any metadata (canonical) is emitted.
  await assertMainSite()
  const p = findProduct(key)
  if (!p) notFound()
  const facts = await getLiveFacts()
  const availability = pageAvailability(key, facts)
  if (availability === "failed") throw new LiveFactsUnavailableError(key, facts.failedSources)
  return { p, facts, off: availability === "off" }
}

/** Product page metadata (main host only; 404 elsewhere). */
export async function productPageMetadata(key: ProductKey): Promise<Metadata> {
  const { p } = await resolveProductPage(key)
  return buildProductMetadata(p)
}

/** Shared template for every registry-driven product page (main site only). */
export async function renderProductPage(key: ProductKey): Promise<JSX.Element> {
  const { p, facts, off } = await resolveProductPage(key)
  const f = facts.products[key]

  const isBuy = p.group === "data" || p.group === "airtime" || p.group === "bills" || p.group === "education"
  const crumbs = productCrumbs(p)
  // Network data pages: the live price table rows (empty when the packages read failed).
  const net = p.group === "data" ? p.network : undefined
  // An off product has nothing on sale: no price rows (and so no OfferCatalog).
  const priceRows = net && !off ? (facts.dataPrices?.[net] ?? []) : []

  return (
    <div className="min-h-screen bg-background">
      <JsonLd data={buildProductJsonLd(p, f, priceRows)} />
      <div className="mx-auto max-w-6xl px-4 py-10 sm:py-16">
        <nav aria-label="Breadcrumb" className="mb-8 text-sm text-muted-foreground">
          <ol className="flex flex-wrap items-center gap-1">
            {crumbs.map((c, i) => (
              <li key={c.path} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                {i < crumbs.length - 1 ? (
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

        <Hero p={p} f={f} isBuy={isBuy} off={off} ussdMain={p.key === "ussd" ? facts.ussd.main : null} />

        {net && !off && <DataPriceTable network={net} rows={priceRows} />}

        <section aria-labelledby="bullets-heading" className="mt-16">
          <h2 id="bullets-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
            What you get
          </h2>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {p.bullets.map((b) => (
              <li key={b} className={`${CARD} flex items-start gap-3 p-5`}>
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
                <span className="text-sm text-foreground">{b}</span>
              </li>
            ))}
          </ul>
        </section>

        {key === "utility-bills" && <BillerCards facts={facts} />}

        {net && <DataNetworkCopy network={net} rows={priceRows} />}

        {net && <CompareNetworks current={key} facts={facts} />}

        <HowToOrder p={p} facts={facts} />

        <TrustStrip />

        <FaqSection faqs={p.faqs} />

        <RelatedProducts keys={p.related} facts={facts} />

        <RelatedGuides entries={landingsForProduct(key, facts)} />

        <div className="mt-16 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
          {" · "}
          <Link href="/services" className="text-primary hover:underline">All services</Link>
        </div>
      </div>
    </div>
  )
}

function Hero({ p, f, isBuy, off, ussdMain }: { p: ProductEntry; f: ProductFacts; isBuy: boolean; off: boolean; ussdMain: string | null }) {
  const price = !off && f.fromPrice != null ? formatCedis(f.fromPrice) : ""
  return (
    <section className="grid grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-12">
      <div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-primary">
          {GROUP_LABEL[p.group]}
        </span>
        <h1 className="mt-4 font-display text-3xl font-bold text-foreground text-balance sm:text-5xl">{p.h1}</h1>
        <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{p.summary}</p>
        {off ? (
          <div role="status" className="mt-8 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-foreground">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
            <div>
              <p className="font-semibold">{p.name} is temporarily unavailable.</p>
              <p className="mt-1 text-muted-foreground">
                We have paused it for now. Please check back soon, or{" "}
                <Link href="/services" className="font-medium text-primary hover:underline">
                  see our other services
                </Link>
                .
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="w-full gap-2 sm:w-auto">
                <Link href="/auth/signup">
                  {isBuy ? "Buy now" : "Get started"} <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </Button>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/auth/login" className="font-medium text-primary hover:underline">
                Log in
              </Link>
            </p>
          </>
        )}
      </div>

      <div className={`${CARD} p-6`}>
        {ussdMain ? (
          <div className="mb-5">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Dial</div>
            <div className="mt-1 font-mono text-4xl font-bold tracking-tight text-primary">{ussdMain}</div>
          </div>
        ) : null}
        {price ? (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Prices start at</div>
            <div className="mt-1 font-display text-3xl font-bold text-foreground">From {price}</div>
          </div>
        ) : p.biller ? (
          <div className="font-display text-xl font-semibold text-foreground">You choose how much to pay</div>
        ) : null}
        <div className={`${price || p.biller ? "mt-5" : ""} flex items-start gap-3 text-sm text-foreground`}>
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>{SPEED_LINE}</span>
        </div>
        <div className="mt-3 flex items-start gap-3 text-sm text-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>{REFUND_LINE}</span>
        </div>
        {f.parts.length > 0 && (
          <div className="mt-5 border-t border-border pt-5">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{PARTS_LABEL[p.group]}</div>
            <ul className="mt-2 flex flex-wrap gap-2" aria-label={PARTS_LABEL[p.group]}>
              {f.parts.map((part) => (
                <li
                  key={part}
                  className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-sm font-medium text-primary"
                >
                  {part}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

function BillerCards({ facts }: { facts: LiveFacts }) {
  const billers = liveBillerEntries(facts)
  if (billers.length === 0) return null
  return (
    <section aria-labelledby="billers-heading" className="mt-16">
      <h2 id="billers-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        Bills you can pay
      </h2>
      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {billers.map((b) => (
          <li key={b.key}>
            <Link href={b.path} className={`${CARD} group flex h-full flex-col p-5 transition-colors hover:border-primary/40`}>
              <span className="font-display font-semibold text-foreground">{b.name}</span>
              <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">{b.summary}</span>
              <span className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-medium text-primary">
                Pay {b.name} <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function HowToOrder({ p, facts }: { p: ProductEntry; facts: LiveFacts }) {
  const { main, shop } = facts.ussd
  const steps = p.channels.map((ch) => {
    if (ch === "web") {
      return {
        key: ch,
        icon: Globe,
        title: "On the website",
        body: "Create a free account or log in, fund your wallet with MoMo or card through Paystack, then choose what you want and pay from your wallet. You can track every order from your dashboard.",
        link: null as { href: string; label: string } | null,
      }
    }
    if (ch === "whatsapp") {
      return {
        key: ch,
        icon: MessageCircle,
        title: "On WhatsApp",
        body: "Chat with DATAGOD on WhatsApp, say what you want and the number to send it to, then approve the MoMo payment prompt.",
        link: p.key !== "whatsapp" ? { href: "/whatsapp", label: "How WhatsApp ordering works" } : null,
      }
    }
    if (!main) return null // no public code configured: don't tell people to dial one
    return {
      key: ch,
      icon: Phone,
      title: "By USSD, no internet needed",
      body: `Dial ${main} on any phone, follow the menu and confirm the MoMo payment prompt.`,
      link: p.key !== "ussd" && facts.products.ussd?.available ? { href: "/ussd", label: "More about USSD ordering" } : null,
    }
  }).filter((s): s is NonNullable<typeof s> => s !== null)

  return (
    <section aria-labelledby="how-heading" className="mt-16">
      <h2 id="how-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        How to order
      </h2>
      <ol className={`mt-6 grid grid-cols-1 gap-4 ${steps.length > 1 ? "sm:grid-cols-2" : ""} ${steps.length > 2 ? "lg:grid-cols-3" : ""}`}>
        {steps.map(({ key, icon: Icon, title, body, link }) => (
          <li key={key} className={`${CARD} p-5`}>
            <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg border border-primary/25 bg-primary/10">
              <Icon className="h-[18px] w-[18px] text-primary" aria-hidden />
            </div>
            <h3 className="mb-1 font-display font-semibold text-foreground">{title}</h3>
            <p className="text-sm text-muted-foreground">{body}</p>
            {link && (
              <Link href={link.href} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                {link.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            )}
          </li>
        ))}
      </ol>
      {p.key === "ussd" && shop && (
        <p className="mt-4 text-sm text-muted-foreground">
          Buying from a DATAGOD reseller? Dial{" "}
          <span className="font-mono font-medium text-foreground">{shop}</span>, then enter your seller&apos;s 4-digit
          shop code when asked. Your seller gives you their code.
        </p>
      )}
    </section>
  )
}

function TrustStrip() {
  const items = [
    { icon: ShieldCheck, text: REFUND_LINE, link: null as { href: string; label: string } | null },
    { icon: CreditCard, text: "Fund your wallet securely with Mobile Money (MoMo) or card through Paystack.", link: null },
    { icon: Headset, text: "Need help? Our support team is on WhatsApp.", link: { href: "/whatsapp", label: "Contact support" } },
  ]
  return (
    <section aria-label="Why DATAGOD" className={`${CARD} mt-16 grid grid-cols-1 gap-5 p-6 sm:grid-cols-3`}>
      {items.map(({ icon: Icon, text, link }) => (
        <div key={text} className="flex items-start gap-3 text-sm text-foreground">
          <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
          <span>
            {text}
            {link && (
              <>
                {" "}
                <Link href={link.href} className="font-medium text-primary hover:underline">
                  {link.label}
                </Link>
              </>
            )}
          </span>
        </div>
      ))}
    </section>
  )
}
