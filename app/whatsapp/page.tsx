import type { Metadata } from "next"
import Link from "next/link"
import { MessageCircle, Package, Zap, FileCheck2, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

export const metadata: Metadata = {
  title: "Order Data & Airtime via WhatsApp | DATAGOD",
  description: "Message DATAGOD on WhatsApp to buy data bundles, airtime, and results-checker vouchers by chat — no app to install.",
  openGraph: {
    title: "Order Data & Airtime via WhatsApp",
    description: "Buy data bundles, airtime, and results-checker vouchers by chatting with DATAGOD on WhatsApp.",
    type: "website",
    url: "https://www.datagod.store/whatsapp",
  },
}

const WHATSAPP_NUMBER = process.env.NEXT_PUBLIC_WHATSAPP_SHOP_NUMBER
const CHAT_LINK = WHATSAPP_NUMBER
  ? `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent("Hi, I'd like to order data")}`
  : null

const steps = [
  { icon: MessageCircle, title: "Message us", desc: "Open WhatsApp and send a message to start." },
  { icon: Package, title: "Pick what you need", desc: "Data, Airtime, or a Results Checker — follow the prompts to choose a bundle and recipient." },
  { icon: Zap, title: "Approve payment", desc: "Approve the Mobile Money prompt on your phone to complete the order." },
]

export default function WhatsAppOrderingPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-16 sm:py-24">
        <div className="text-center max-w-2xl mx-auto">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-primary">
            Order by chat
          </span>
          <h1 className="mt-4 font-display text-3xl sm:text-5xl font-bold text-foreground text-balance">
            Buy data & airtime on WhatsApp
          </h1>
          <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
            No app to install. Message us, pick a bundle, and approve the payment prompt — done in seconds.
          </p>
          <div className="mt-8 flex justify-center">
            {CHAT_LINK ? (
              <a href={CHAT_LINK} target="_blank" rel="noopener noreferrer">
                <Button size="lg" className="gap-2">
                  Chat on WhatsApp <ArrowRight className="w-4 h-4" />
                </Button>
              </a>
            ) : (
              <div className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-muted-foreground">
                WhatsApp ordering is being set up — check back soon.
              </div>
            )}
          </div>
        </div>

        <div className="mt-16 space-y-6">
          {steps.map(({ icon: Icon, title, desc }, i) => (
            <div key={title} className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center shadow">
                {i + 1}
              </div>
              <div className="flex-1 pb-6 border-b border-border last:border-0 last:pb-0">
                <div className="flex items-center gap-2 mb-1">
                  <Icon className="w-4 h-4 text-primary" />
                  <h4 className="font-semibold text-foreground text-sm">{title}</h4>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-xl border border-border bg-card p-5 flex items-start gap-3">
          <FileCheck2 className="w-[18px] h-[18px] text-primary shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">
            Results-checker vouchers and services are available the same way — just tell us what you need in the chat.
          </p>
        </div>

        <div className="mt-8 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
          {" · "}
          <Link href="/ai" className="text-primary hover:underline">DATAGOD AI</Link>
        </div>
      </div>
    </div>
  )
}
