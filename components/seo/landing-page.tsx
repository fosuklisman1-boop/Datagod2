import type { Metadata } from "next"
import type { JSX } from "react"
import Link from "next/link"
import { AlertTriangle, ArrowRight, ChevronRight, Clock, Info, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { assertMainSite } from "@/lib/seo/site"
import { getProduct, REFUND_LINE, SPEED_LINE, type ProductKey } from "@/lib/seo/products"
import { getLiveFacts, LiveFactsUnavailableError, type LiveFacts } from "@/lib/seo/live-facts"
import { buildLandingJsonLd, landingCrumbs } from "@/lib/seo/json-ld"
import { buildProductMetadata } from "@/lib/seo/page-meta"
import {
  availableLandings,
  getLanding,
  landingAvailability,
  landingGroups,
  landingSections,
  type LandingEntry,
  type LandingKey,
} from "@/lib/seo/landing-pages"
import { networkOf, type PriceGroup } from "@/lib/seo/data-prices"
import { authUrl } from "@/lib/post-auth-redirect"
import { JsonLd } from "./json-ld-script"
import { FaqSection } from "./faq-section"
import { RelatedProducts } from "./related-products"
import { RelatedGuides } from "./related-guides"
import { PriceTable } from "./price-table"
import { BuyButton } from "./buy-button"

type DataNet = "MTN" | "Telecel" | "AT"

const CARD = "rounded-xl border border-white/60 dark:border-white/5 bg-card clay"

const NET_PRODUCT: Record<DataNet, ProductKey> = { MTN: "mtn-data", Telecel: "telecel-data", AT: "at-data" }

/**
 * Same status policy as the product pages (components/seo/product-page.tsx):
 * failed read -> throw (5xx, also enforced by the root layout through
 * lib/seo/product-status.ts), off -> 200 with a notice, ok -> the page.
 */
async function resolveLandingPage(key: LandingKey): Promise<{ e: LandingEntry; facts: LiveFacts; off: boolean }> {
  await assertMainSite()
  const e = getLanding(key)
  const facts = await getLiveFacts()
  const availability = landingAvailability(e, facts)
  if (availability === "failed") throw new LiveFactsUnavailableError(key, facts.failedSources)
  return { e, facts, off: availability === "off" }
}

/** Landing page metadata (main host only; 404 elsewhere). */
export async function landingPageMetadata(key: LandingKey): Promise<Metadata> {
  const { e } = await resolveLandingPage(key)
  return buildProductMetadata(e)
}

export interface LandingExtras {
  /**
   * Whether the dashboard Standard Bundles sell Telecel with the No Expiry
   * category visible (non-expiry page). Called only after the main-site check
   * and the availability check, so it never runs for a 404 or a 5xx.
   */
  standardNoExpiry?: () => Promise<boolean>
}

/** Shared template for every landing page (main site only). */
export async function renderLandingPage(key: LandingKey, extras: LandingExtras = {}): Promise<JSX.Element> {
  const { e, facts, off } = await resolveLandingPage(key)
  const parent = e.parent ? getProduct(e.parent) : undefined
  const crumbs = landingCrumbs(e, parent)
  // An off page has nothing on sale: no price lists.
  const groups = off ? [] : landingGroups(e, facts)
  const rowCount = groups.reduce((n, g) => n + g.rows.length, 0)
  const byNet = groupsByNetwork(groups)
  const standardNoExpiry = extras.standardNoExpiry ? await extras.standardNoExpiry() : false
  const sections = landingSections(e, { rows: rowCount, standardNoExpiry })
  const others = availableLandings(facts).filter((o) => o.key !== e.key)
  const liveNetPages = (Object.keys(NET_PRODUCT) as DataNet[]).filter((n) => facts.products[NET_PRODUCT[n]]?.available === true)

  return (
    <div className="min-h-screen bg-background">
      <JsonLd data={buildLandingJsonLd(e, crumbs)} />
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

        <Hero e={e} off={off} networks={byNet.map((g) => g.network)} />

        {e.steps && e.steps.length > 0 && (
          <section aria-labelledby="steps-heading" className="mt-16">
            <h2 id="steps-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
              How it works, step by step
            </h2>
            <ol className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {e.steps.map((s, i) => (
                <li key={s.title} className={`${CARD} p-5`}>
                  <div className="mb-3 grid h-9 w-9 place-items-center rounded-lg border border-primary/25 bg-primary/10 font-display font-bold text-primary">
                    {i + 1}
                  </div>
                  <h3 className="mb-1 font-display font-semibold text-foreground">{s.title}</h3>
                  <p className="text-sm text-muted-foreground">{s.body}</p>
                </li>
              ))}
            </ol>
          </section>
        )}

        {byNet.map(({ network, groups: gs }) => (
          <div key={network}>
            <PriceTable name={tableName(e, network)} groups={gs} loadedAt={facts.loadedAt} headingId={`prices-${network.toLowerCase()}`} />
            {e.kind !== "at-type" && facts.products[NET_PRODUCT[network]]?.available === true && <NetLink net={network} />}
          </div>
        ))}

        {e.kind === "non-expiry" && rowCount === 0 && (
          <div role="status" className={`${CARD} mt-16 flex items-start gap-3 p-5 text-sm text-foreground`}>
            <Info className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="font-semibold">No bundle in our catalogue is marked no-expiry right now.</p>
              {liveNetPages.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  See every bundle on sale:{" "}
                  {liveNetPages.map((n, i) => (
                    <span key={n}>
                      {i > 0 && ", "}
                      <Link href={getProduct(NET_PRODUCT[n]).path} className="font-medium text-primary hover:underline">
                        {n} data
                      </Link>
                    </span>
                  ))}
                  .
                </p>
              )}
            </div>
          </div>
        )}

        {sections.map((s, i) => (
          <section key={s.heading} aria-labelledby={`copy-${i}`} className="mt-16 max-w-3xl">
            <h2 id={`copy-${i}`} className="font-display text-2xl sm:text-3xl font-bold text-foreground">
              {s.heading}
            </h2>
            <div className="mt-6 space-y-4 text-base leading-relaxed text-muted-foreground">
              {s.paragraphs.map((t) => (
                <p key={t}>{t}</p>
              ))}
            </div>
          </section>
        ))}

        {e.kind === "non-expiry" && standardNoExpiry && (
          <p className="mt-4 max-w-3xl text-sm text-muted-foreground">
            <Link href={authUrl("login", "/dashboard/standard-bundles")} className="font-medium text-primary hover:underline">
              Log in to open Standard Bundles
            </Link>{" "}
            or{" "}
            <Link href={authUrl("signup", "/dashboard/standard-bundles")} className="font-medium text-primary hover:underline">
              create a free account
            </Link>
            .
          </p>
        )}

        <FaqSection faqs={e.faqs} />

        <RelatedProducts keys={e.relatedProducts} facts={facts} />

        <RelatedGuides entries={others} title="More guides and price lists" />

        <div className="mt-16 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
          {" · "}
          <Link href="/services" className="text-primary hover:underline">All services</Link>
        </div>
      </div>
    </div>
  )
}

/** PriceTable heading is "<name> prices". */
function tableName(e: LandingEntry, net: DataNet): string {
  if (e.kind === "at-type") return `AT ${e.atType} data bundle`
  return `${net} no-expiry data bundle`
}

/** Price groups per network (MTN, Telecel, AT), networks without groups left out. */
function groupsByNetwork(groups: readonly PriceGroup[]): Array<{ network: DataNet; groups: PriceGroup[] }> {
  return (["MTN", "Telecel", "AT"] as const)
    .map((network) => ({ network, groups: groups.filter((g) => networkOf(g.network) === network) }))
    .filter((x) => x.groups.length > 0)
}

function NetLink({ net }: { net: DataNet }) {
  const p = getProduct(NET_PRODUCT[net])
  return (
    <Link href={p.path} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
      More about {net} data <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  )
}

function Hero({ e, off, networks }: { e: LandingEntry; off: boolean; networks: DataNet[] }) {
  const reseller = e.kind === "reseller"
  return (
    <section className="grid grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-12">
      <div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-primary">
          {reseller ? "For resellers" : "Data bundles"}
        </span>
        <h1 className="mt-4 font-display text-3xl font-bold text-foreground text-balance sm:text-5xl">{e.h1}</h1>
        <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{e.lede}</p>
        {off ? (
          <div role="status" className="mt-8 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-foreground">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
            <div>
              <p className="font-semibold">{e.name} {reseller ? "is" : "are"} temporarily unavailable.</p>
              <p className="mt-1 text-muted-foreground">
                Nothing on this page is on sale right now. Please check back soon, or{" "}
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
              {reseller ? (
                <Button asChild size="lg" className="w-full gap-2 sm:w-auto">
                  <Link href="/join">
                    Open your shop <ArrowRight className="h-4 w-4" aria-hidden />
                  </Link>
                </Button>
              ) : (
                <BuyButton label="Buy data now" />
              )}
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
        <div className="flex items-start gap-3 text-sm text-foreground">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>{SPEED_LINE}</span>
        </div>
        <div className="mt-3 flex items-start gap-3 text-sm text-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>{REFUND_LINE}</span>
        </div>
        {networks.length > 0 && (
          <div className="mt-5 border-t border-border pt-5">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Networks on this page</div>
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="Networks on this page">
              {networks.map((n) => (
                <li key={n} className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                  {n}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
