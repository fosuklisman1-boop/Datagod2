import type { Metadata } from "next"
import Link from "next/link"
import { Cpu, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

export const metadata: Metadata = {
  title: "DATAGOD AI | One Assistant, Every Surface | DATAGOD",
  description: "DATAGOD AI helps you browse plans, track orders, and order data or airtime by chat — on the web, in your shop, on WhatsApp, and in the dealer dashboard.",
  openGraph: {
    title: "DATAGOD AI | One Assistant, Every Surface",
    description: "One AI assistant across the web, your shop, WhatsApp, and the dealer dashboard.",
    type: "website",
    url: "https://www.datagod.store/ai",
  },
}

// Reuses the exact copy already live on the homepage's "DATAGOD AI" card
// (app/page.tsx) so this page never contradicts what's already shipped there.
const SURFACES = [
  ["WEB", "Browse plans, track any order, explain dealer pricing."],
  ["SHOP", "Find bundles & start checkout for you."],
  ["WHATSAPP", "Order by chat, re-verify stuck top-ups, file complaints."],
  ["DEALER", "“Buy 5GB MTN for 024…”, today's sales, manage USSD."],
  ["ADMIN", "Fulfil orders & manage users, shops & payouts by chat."],
] as const

export default function AiPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-16 sm:py-24">
        <div className="text-center max-w-2xl mx-auto">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-primary">
            <Cpu className="w-3 h-3" /> DATAGOD AI
          </span>
          <h1 className="mt-4 font-display text-3xl sm:text-5xl font-bold text-foreground text-balance">
            One assistant, every surface you use
          </h1>
          <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
            The same DATAGOD AI meets you on the web, in your shop, on WhatsApp, and in the dealer dashboard — so you never have to explain yourself twice.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/whatsapp">
              <Button size="lg" className="gap-2 w-full sm:w-auto">
                Try it on WhatsApp <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Link href="/">
              <Button size="lg" variant="outline" className="w-full sm:w-auto">
                Ask it on the homepage
              </Button>
            </Link>
          </div>
        </div>

        <div className="mt-16 rounded-xl border border-border bg-card p-4 max-w-xl mx-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-display text-sm font-semibold text-foreground">
              <Cpu className="w-[18px] h-[18px] text-primary" /> DATAGOD AI
            </div>
            <span className="flex items-center gap-1.5 font-mono text-[9px] text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />ONLINE
            </span>
          </div>
          <p className="mt-1 mb-3 text-[11px] text-muted-foreground">One assistant — tuned for every surface you use.</p>
          {SURFACES.map(([tag, txt]) => (
            <div key={tag} className="flex gap-3 border-t border-border py-2">
              <div className="w-16 shrink-0 font-mono text-[9px] leading-snug text-primary">{tag}</div>
              <div className="text-[11px] text-muted-foreground">{txt}</div>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
          {" · "}
          <Link href="/whatsapp" className="text-primary hover:underline">Order via WhatsApp</Link>
        </div>
      </div>
    </div>
  )
}
