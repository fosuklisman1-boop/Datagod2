import type { Metadata } from "next"
import Link from "next/link"
import {
  Send, Hash, BookUser, LayoutTemplate, ArrowRight, CheckCircle2, ChevronRight, Clock, ShieldCheck,
  KeyRound, BellRing, Megaphone, Building2, Code2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { supabaseAdmin } from "@/lib/supabase"
import { getProduct, REFUND_LINE, SPEED_LINE } from "@/lib/seo/products"
import { formatCedis, getLiveFacts } from "@/lib/seo/live-facts"
import { buildProductJsonLd, productCrumbs } from "@/lib/seo/json-ld"
import { isMainSiteRequest } from "@/lib/seo/site"
import { JsonLd } from "@/components/seo/json-ld-script"
import { FaqSection } from "@/components/seo/faq-section"
import { RelatedProducts } from "@/components/seo/related-products"

export const metadata: Metadata = {
  alternates: { canonical: "https://www.datagod.store/bulk-sms" },
  title: "Bulk SMS Ghana | Send Campaigns with Your Own Sender ID | DATAGOD",
  description: "Send bulk SMS campaigns in Ghana with your own sender ID, address book, and templates. Prepaid credits, pay as you go, no monthly contract.",
  openGraph: {
    title: "Bulk SMS Ghana | Send Campaigns with Your Own Sender ID",
    description: "Prepaid bulk SMS with your own sender ID, address book, and templates. No monthly contract.",
    type: "website",
    url: "https://www.datagod.store/bulk-sms",
  },
  twitter: {
    card: "summary_large_image",
    title: "Bulk SMS Ghana | Send Campaigns with Your Own Sender ID",
    description: "Prepaid bulk SMS with your own sender ID, address book, and templates. No monthly contract.",
    images: ["/og-image.png"],
  },
}

// Activation fee and welcome credits mirror the exact tenant_global_settings
// keys and fallbacks the signed-in dashboard reads (app/api/sms/account/route.ts).
// The per-SMS price comes from getLiveFacts() (same sms_price_per_credit row,
// but no default: an unset price is hidden rather than guessed).
export const revalidate = 300

async function getSmsAccountTerms() {
  const { data } = await supabaseAdmin
    .from("tenant_global_settings")
    .select("key, value")
    .in("key", ["sms_activation_fee", "sms_welcome_bonus_credits"])

  const map: Record<string, number> = {}
  for (const row of (data ?? []) as { key: string; value: { amount?: number; units?: number } }[]) {
    if (row.key === "sms_activation_fee") map.activationFee = Number(row.value?.amount ?? 0)
    if (row.key === "sms_welcome_bonus_credits") map.welcomeBonusCredits = Number(row.value?.units ?? 0)
  }

  return {
    activationFee: map.activationFee ?? 20,
    welcomeBonusCredits: map.welcomeBonusCredits ?? 10,
  }
}

const CARD = "rounded-xl border border-white/60 dark:border-white/5 bg-card clay"

const FEATURES = [
  { icon: Hash, title: "Your own sender ID", desc: "Messages arrive from your business name, not a shared shortcode, once your sender ID is approved." },
  { icon: BookUser, title: "Address book", desc: "Import and organize your contacts into lists for targeted campaigns." },
  { icon: LayoutTemplate, title: "Message templates", desc: "Save and reuse templates for recurring announcements and promos." },
  { icon: Send, title: "Prepaid credits", desc: "Top up units and send — no monthly contract." },
]

const USE_CASES = [
  { icon: KeyRound, title: "OTP and verification codes", desc: "Send one-time codes to confirm sign-ups, logins and payments." },
  { icon: BellRing, title: "Alerts and reminders", desc: "Payment reminders, appointment alerts, delivery updates and notices." },
  { icon: Megaphone, title: "Marketing campaigns", desc: "Promotions, new arrivals and offers sent to your whole contact list." },
  { icon: Building2, title: "Schools, churches and businesses", desc: "Reach parents, members, staff and customers with one message." },
]

export default async function BulkSmsPage() {
  const [terms, facts, mainSite] = await Promise.all([getSmsAccountTerms(), getLiveFacts(), isMainSiteRequest()])
  const p = getProduct("bulk-sms")
  const f = facts.products["bulk-sms"]
  const perSms = f.fromPrice != null ? formatCedis(f.fromPrice) : ""
  const apiAvailable = mainSite && facts.products.developers?.available === true
  const crumbs = productCrumbs(p)

  return (
    <div className="min-h-screen bg-background">
      {mainSite && <JsonLd data={buildProductJsonLd(p, f)} />}
      <div className="mx-auto max-w-6xl px-4 py-10 sm:py-16">
        {mainSite && (
          <nav aria-label="Breadcrumb" className="mb-8 text-sm text-muted-foreground">
            <ol className="flex flex-wrap items-center gap-1">
              {crumbs.map((c, i) => (
                <li key={c.path} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                  {i < crumbs.length - 1 ? (
                    <Link href={c.path} className="hover:text-primary hover:underline">{c.name}</Link>
                  ) : (
                    <span aria-current="page" className="text-foreground">{c.name}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}

        {/* Hero */}
        <section className="grid grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-12">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-primary">
              Bulk SMS
            </span>
            <h1 className="mt-4 font-display text-3xl font-bold text-foreground text-balance sm:text-5xl">
              Send SMS campaigns from your own sender ID
            </h1>
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              Prepaid bulk SMS for businesses in Ghana — your own sender ID, address book, and templates.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="w-full gap-2 sm:w-auto">
                <Link href="/auth/signup">
                  Get started <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
                <Link href="/auth/login">Sign in to send</Link>
              </Button>
            </div>
          </div>

          <div className={`${CARD} p-6`}>
            {perSms && (
              <div className="mb-5">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Prices start at</div>
                <div className="mt-1 font-display text-3xl font-bold text-foreground">From {perSms} per SMS</div>
              </div>
            )}
            <div className="flex items-start gap-3 text-sm text-foreground">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span>{SPEED_LINE}</span>
            </div>
            <div className="mt-3 flex items-start gap-3 text-sm text-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span>{REFUND_LINE}</span>
            </div>
            <div className="mt-3 flex items-start gap-3 text-sm text-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span>Prepaid credits, no monthly contract. Buy with MoMo or card through Paystack.</span>
            </div>
          </div>
        </section>

        {/* Features */}
        <section aria-labelledby="features-heading" className="mt-16">
          <h2 id="features-heading" className="font-display text-2xl font-bold text-foreground sm:text-3xl">
            What you get
          </h2>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <li key={title} className={`${CARD} p-5`}>
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg border border-primary/25 bg-primary/10">
                  <Icon className="h-[18px] w-[18px] text-primary" aria-hidden />
                </div>
                <h3 className="mb-1 font-display font-semibold text-foreground">{title}</h3>
                <p className="text-sm text-muted-foreground">{desc}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Sender ID */}
        <section aria-labelledby="sender-heading" className={`${CARD} mt-16 grid grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_1.4fr] lg:gap-10 lg:p-8`}>
          <div>
            <h2 id="sender-heading" className="font-display text-2xl font-bold text-foreground sm:text-3xl">
              Your own sender ID
            </h2>
            <p className="mt-3 text-muted-foreground">
              Your messages show your business name (up to 11 characters) instead of a random number, so people know who is texting them.
            </p>
          </div>
          <ol className="space-y-4">
            {[
              "Create your account and request a sender ID from your SMS dashboard.",
              "Every sender ID is reviewed before it can be used, so request yours early.",
              "Once it is approved, choose it when you send a campaign.",
            ].map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                  {i + 1}
                </span>
                <span className="pt-0.5 text-sm text-foreground">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Use cases */}
        <section aria-labelledby="uses-heading" className="mt-16">
          <h2 id="uses-heading" className="font-display text-2xl font-bold text-foreground sm:text-3xl">
            What people use it for
          </h2>
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {USE_CASES.map(({ icon: Icon, title, desc }) => (
              <li key={title} className={`${CARD} p-5`}>
                <Icon className="mb-3 h-5 w-5 text-primary" aria-hidden />
                <h3 className="mb-1 font-display font-semibold text-foreground">{title}</h3>
                <p className="text-sm text-muted-foreground">{desc}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Pricing */}
        <section aria-labelledby="pricing-heading" className={`${CARD} mt-16 p-6`}>
          <h2 id="pricing-heading" className="mb-4 font-display text-2xl font-bold text-foreground">Pricing</h2>
          <div className={`grid grid-cols-1 gap-4 ${perSms ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            {perSms && (
              <div>
                <div className="font-display text-2xl font-bold text-foreground">{perSms}</div>
                <div className="mt-1 text-xs text-muted-foreground">per SMS credit</div>
              </div>
            )}
            <div>
              <div className="font-display text-2xl font-bold text-foreground">GHS {terms.activationFee.toFixed(2)}</div>
              <div className="mt-1 text-xs text-muted-foreground">one-time activation fee</div>
            </div>
            <div>
              <div className="font-display text-2xl font-bold text-foreground">{terms.welcomeBonusCredits}</div>
              <div className="mt-1 text-xs text-muted-foreground">free welcome credits</div>
            </div>
          </div>
          <div className="mt-4 flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span>Activation unlocks sending and grants your welcome credits immediately.</span>
          </div>
        </section>

        {/* SMS API — only while the developer API is switched on */}
        {apiAvailable && (
          <section aria-labelledby="api-heading" className={`${CARD} mt-6 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between`}>
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10">
                <Code2 className="h-[18px] w-[18px] text-primary" aria-hidden />
              </div>
              <div>
                <h2 id="api-heading" className="font-display font-semibold text-foreground">Send SMS from your own system</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Use the DATAGOD API to send SMS from your app, website or bot, such as sign-up codes and order updates.
                </p>
              </div>
            </div>
            <Link href="/developers" className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline">
              Read the API docs <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </section>
        )}

        {mainSite && <FaqSection faqs={p.faqs} />}

        {mainSite && <RelatedProducts keys={p.related} facts={facts} />}

        <div className="mt-16 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
          {" · "}
          <Link href="/join" className="text-primary hover:underline">Become an Agent</Link>
        </div>
      </div>
    </div>
  )
}
