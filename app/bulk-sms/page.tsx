import type { Metadata } from "next"
import Link from "next/link"
import { Send, Hash, BookUser, LayoutTemplate, ArrowRight, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { supabaseAdmin } from "@/lib/supabase"

export const metadata: Metadata = {
  title: "Bulk SMS Ghana | Send Campaigns with Your Own Sender ID | DATAGOD",
  description: "Send bulk SMS campaigns in Ghana with your own sender ID, address book, and templates. Prepaid credits, pay as you go, no monthly contract.",
  openGraph: {
    title: "Bulk SMS Ghana | Send Campaigns with Your Own Sender ID",
    description: "Prepaid bulk SMS with your own sender ID, address book, and templates. No monthly contract.",
    type: "website",
    url: "https://www.datagod.store/bulk-sms",
  },
}

// Live pricing, not hardcoded — mirrors the exact same tenant_global_settings
// keys and fallbacks the signed-in dashboard reads (app/api/sms/account/route.ts),
// so this page can never drift from what a customer actually gets charged.
export const revalidate = 300

async function getSmsPricing() {
  const { data } = await supabaseAdmin
    .from("tenant_global_settings")
    .select("key, value")
    .in("key", ["sms_activation_fee", "sms_welcome_bonus_credits", "sms_price_per_credit"])

  const map: Record<string, number> = {}
  for (const row of (data ?? []) as { key: string; value: { amount?: number; units?: number } }[]) {
    if (row.key === "sms_activation_fee") map.activationFee = Number(row.value?.amount ?? 0)
    if (row.key === "sms_welcome_bonus_credits") map.welcomeBonusCredits = Number(row.value?.units ?? 0)
    if (row.key === "sms_price_per_credit") map.pricePerCredit = Number(row.value?.amount ?? 0)
  }

  return {
    activationFee: map.activationFee ?? 20,
    welcomeBonusCredits: map.welcomeBonusCredits ?? 10,
    pricePerCredit: map.pricePerCredit && map.pricePerCredit > 0 ? map.pricePerCredit : 0.04,
  }
}

export default async function BulkSmsPage() {
  const pricing = await getSmsPricing()

  const features = [
    { icon: Hash, title: "Your own sender ID", desc: "Messages arrive from your business name, not a shared shortcode." },
    { icon: BookUser, title: "Address book", desc: "Import and organize your contacts into lists for targeted campaigns." },
    { icon: LayoutTemplate, title: "Message templates", desc: "Save and reuse templates for recurring announcements and promos." },
    { icon: Send, title: "Prepaid credits", desc: "Top up units and send — no monthly contract or minimum spend." },
  ]

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-16 sm:py-24">
        <div className="text-center max-w-2xl mx-auto">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-primary">
            Bulk SMS
          </span>
          <h1 className="mt-4 font-display text-3xl sm:text-5xl font-bold text-foreground text-balance">
            Send SMS campaigns from your own sender ID
          </h1>
          <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
            Prepaid bulk SMS for businesses in Ghana — your own sender ID, address book, and templates. Pay only for what you send.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/auth/signup">
              <Button size="lg" className="gap-2 w-full sm:w-auto">
                Get started <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Link href="/auth/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto">
                Sign in to send
              </Button>
            </Link>
          </div>
        </div>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {features.map(({ icon: Icon, title, desc }) => (
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
          <h2 className="font-display font-semibold text-foreground mb-4">Pricing</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <div className="font-display text-2xl font-bold text-foreground">GHS {pricing.pricePerCredit.toFixed(2)}</div>
              <div className="text-xs text-muted-foreground mt-1">per SMS credit</div>
            </div>
            <div>
              <div className="font-display text-2xl font-bold text-foreground">GHS {pricing.activationFee.toFixed(2)}</div>
              <div className="text-xs text-muted-foreground mt-1">one-time activation fee</div>
            </div>
            <div>
              <div className="font-display text-2xl font-bold text-foreground">{pricing.welcomeBonusCredits}</div>
              <div className="text-xs text-muted-foreground mt-1">free welcome credits</div>
            </div>
          </div>
          <div className="mt-4 flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
            <span>Activation unlocks sending and grants your welcome credits immediately.</span>
          </div>
        </div>

        <div className="mt-8 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
          {" · "}
          <Link href="/join" className="text-primary hover:underline">Become an Agent</Link>
        </div>
      </div>
    </div>
  )
}
