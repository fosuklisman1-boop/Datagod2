import type { Metadata } from "next"
import Link from "next/link"
import { Store, Wallet, Users, Banknote, MessageCircle, ArrowRight, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { supabaseAdmin } from "@/lib/supabase"

// This exact URL was already declared canonical in app/sitemap.ts's staticRoutes
// before this file existed — app/join only had the invite-gated [code] route, so
// "/join" itself 404'd while being submitted to Google as an indexable page. This
// file is that page: a real, public "become an agent" landing page at the slug
// the sitemap already promised.
export const metadata: Metadata = {
  title: "Become a DATAGOD Agent | Sell Data & Airtime, Keep the Profit",
  description: "Open your own DATAGOD storefront, buy data and airtime at wholesale prices, set your own prices, and withdraw your profit to Mobile Money. Free to start.",
  openGraph: {
    title: "Become a DATAGOD Agent | Sell Data & Airtime, Keep the Profit",
    description: "Open your own DATAGOD storefront, buy at wholesale prices, and keep the profit on every sale.",
    type: "website",
    url: "https://www.datagod.store/join",
  },
}

// Revalidate periodically so the WhatsApp bot fee below reflects whatever an
// admin currently has configured, without a live DB round trip per pageview.
export const revalidate = 300

async function getWhatsAppShopFee(): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("whatsapp_shop_activation_fee")
    .is("key", null)
    .maybeSingle()
  const fee = Number((data as { whatsapp_shop_activation_fee?: number } | null)?.whatsapp_shop_activation_fee ?? 0)
  return fee > 0 ? fee : null
}

export default async function JoinPage() {
  const whatsappFee = await getWhatsAppShopFee()

  const benefits = [
    { icon: Store, title: "Your own storefront", desc: "A white-label shop with your own name, logo and prices — shareable as your own link." },
    { icon: Wallet, title: "Wholesale pricing", desc: "Buy data, airtime, AFA registrations and results-checker vouchers at cost." },
    { icon: CheckCircle2, title: "Set your own prices", desc: "Mark up however you like and keep every cedi of the difference." },
    { icon: Banknote, title: "Withdraw anytime", desc: "Cash out your profit straight to Mobile Money." },
    { icon: Users, title: "Build your own network", desc: "Invite sub-agents beneath you and earn a margin on what they sell." },
  ]

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-16 sm:py-24">
        <div className="text-center max-w-2xl mx-auto">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-primary">
            Become an agent
          </span>
          <h1 className="mt-4 font-display text-3xl sm:text-5xl font-bold text-foreground text-balance">
            Sell data & airtime. Keep the profit.
          </h1>
          <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
            Open a free DATAGOD storefront, buy MTN, Telecel and AT bundles at wholesale prices, and sell them at whatever price you choose.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/auth/signup">
              <Button size="lg" className="gap-2 w-full sm:w-auto">
                Create your shop <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Link href="/auth/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto">
                I already have an account
              </Button>
            </Link>
          </div>
        </div>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {benefits.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-xl border border-border bg-card p-5">
              <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg border border-primary/25 bg-primary/10">
                <Icon className="h-[18px] w-[18px] text-primary" />
              </div>
              <h3 className="font-display font-semibold text-foreground mb-1">{title}</h3>
              <p className="text-sm text-muted-foreground">{desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-xl border border-border bg-card p-6">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10">
              <MessageCircle className="h-[18px] w-[18px] text-primary" />
            </div>
            <div>
              <h3 className="font-display font-semibold text-foreground mb-1">Your own WhatsApp ordering bot</h3>
              {whatsappFee !== null ? (
                <p className="text-sm text-muted-foreground">
                  Once your shop is set up, activate a WhatsApp bot for your own customers to order by chat — a one-time fee of GHS {whatsappFee.toFixed(2)}.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  A WhatsApp ordering bot for your own shop is coming soon — check your dashboard after signing up.
                </p>
              )}
            </div>
          </div>
        </div>

        <p className="mt-10 text-center text-sm text-muted-foreground">
          Already got an invite link from another agent? Use the link they shared with you to join under their network instead.
        </p>

        <div className="mt-8 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
          {" · "}
          <Link href="/terms" className="text-primary hover:underline">Terms of Service</Link>
        </div>
      </div>
    </div>
  )
}
