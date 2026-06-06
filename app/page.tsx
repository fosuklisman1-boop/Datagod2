"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Package, Zap, Users, ArrowRight, Lock,
  ShoppingCart, Wallet, GraduationCap, Store,
  CheckCircle2, CreditCard, Phone, UserPlus,
  TrendingUp, Share2, Settings, Search, ChevronDown, Link2, Copy, Mail, Banknote, MessageCircle
} from "lucide-react"
import GuestPurchaseButton from "@/components/GuestPurchaseButton"
import { HomeAIChatWidget } from "@/components/home/AIChatWidget"
import { useCommunityLink } from "@/hooks/use-community-link"
import { Skeleton } from "@/components/ui/skeleton"

function Step({
  number,
  icon,
  title,
  description,
  mockup,
}: {
  number: number
  icon: React.ReactNode
  title: string
  description: string
  mockup?: React.ReactNode
}) {
  const paragraphs = description.split("\n\n").filter(Boolean)
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-primary to-purple-600 text-white text-sm font-bold flex items-center justify-center shadow">
        {number}
      </div>
      <div className="flex-1 pb-6 border-b border-border last:border-0 last:pb-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-primary">{icon}</span>
          <h4 className="font-semibold text-foreground text-sm">{title}</h4>
        </div>
        <div className="space-y-2 mb-3">
          {paragraphs.map((p, i) => (
            <p key={i} className="text-sm text-muted-foreground leading-relaxed">{p}</p>
          ))}
        </div>
        {mockup && (
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            {mockup}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Mini UI Mockups ─────────────────────────── */

function MockNetworkPicker() {
  return (
    <div className="p-3 bg-muted/40">
      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Select Network</p>
      <div className="grid grid-cols-4 gap-2">
        {[
          { name: "MTN", color: "bg-yellow-400" },
          { name: "Telecel", color: "bg-red-500" },
          { name: "AT-iShare", color: "bg-primary" },
          { name: "AT-BigTime", color: "bg-purple-600" },
        ].map((n, i) => (
          <div key={n.name} className={`rounded-lg border-2 p-2 text-center ${i === 0 ? "border-primary bg-primary/5" : "border-border"}`}>
            <div className={`w-5 h-5 ${n.color} rounded-full mx-auto mb-1`} />
            <p className="text-[9px] font-bold text-foreground">{n.name}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function MockPackageCard() {
  return (
    <div className="p-3 bg-muted/40 flex gap-2">
      {[{ size: "1GB", price: "5.00" }, { size: "3GB", price: "12.00" }, { size: "5GB", price: "18.00" }].map((p) => (
        <div key={p.size} className="flex-1 bg-card border border-border rounded-xl p-2 text-center shadow-sm">
          <p className="text-sm font-black text-foreground">{p.size}</p>
          <p className="text-[10px] text-muted-foreground mb-1">MTN</p>
          <p className="text-xs font-bold text-primary">GHS {p.price}</p>
        </div>
      ))}
    </div>
  )
}

function MockCheckout() {
  return (
    <div className="p-3 bg-muted/40 space-y-2">
      <div className="bg-card border border-border rounded-lg px-3 py-1.5 flex items-center gap-2">
        <Phone className="w-3 h-3 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">0201234567</span>
      </div>
      <div className="bg-card border border-border rounded-lg px-3 py-1.5 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">john@email.com</span>
      </div>
      <div className="bg-gradient-to-r from-primary to-purple-600 rounded-lg py-1.5 text-center">
        <span className="text-[11px] font-bold text-white">Order Now — GHS 5.00</span>
      </div>
    </div>
  )
}

function MockPaystack() {
  return (
    <div className="p-3 bg-muted/40 text-center space-y-2">
      <div className="inline-flex items-center gap-1.5 bg-card border border-border rounded-full px-3 py-1 shadow-sm">
        <Lock className="w-3 h-3 text-green-600" />
        <span className="text-[10px] font-semibold text-foreground">Secured by Paystack</span>
      </div>
      <div className="bg-card border border-border rounded-lg p-2 flex items-center gap-2">
        <CreditCard className="w-4 h-4 text-muted-foreground" />
        <div className="flex-1 h-2 bg-muted rounded" />
        <span className="text-[10px] text-muted-foreground">****</span>
      </div>
      <p className="text-[10px] text-orange-600 font-semibold">⚠ Do not close this tab until confirmed</p>
    </div>
  )
}

function MockSuccess() {
  return (
    <div className="p-4 bg-green-50 text-center space-y-1">
      <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto" />
      <p className="text-xs font-bold text-green-700">Data Delivered!</p>
      <p className="text-[10px] text-green-600">1GB sent to 0201234567</p>
    </div>
  )
}

function MockWallet() {
  return (
    <div className="p-3 bg-muted/40 space-y-2">
      <div className="bg-gradient-to-r from-primary to-purple-600 rounded-xl p-3 text-white">
        <p className="text-[10px] opacity-80">Wallet Balance</p>
        <p className="text-lg font-black">GHS 50.00</p>
      </div>
      <div className="bg-card border border-border rounded-lg py-1.5 text-center">
        <span className="text-[11px] font-semibold text-primary">+ Top Up Wallet</span>
      </div>
    </div>
  )
}

function MockShopLink() {
  return (
    <div className="p-3 bg-muted/40">
      <div className="bg-card border border-border rounded-lg px-3 py-2 flex items-center gap-2">
        <Store className="w-3 h-3 text-purple-600 flex-shrink-0" />
        <span className="text-[11px] text-muted-foreground truncate">datagod.store/shop/<span className="font-bold text-purple-600">your-shop</span></span>
        <Share2 className="w-3 h-3 text-muted-foreground flex-shrink-0 ml-auto" />
      </div>
      <p className="text-[10px] text-muted-foreground mt-1.5 text-center">Share this link with your customers</p>
    </div>
  )
}

function MockTrackOrder() {
  return (
    <div className="p-3 bg-muted/40 space-y-1.5">
      {[
        { label: "3GB MTN Data", status: "Delivered", color: "text-green-600 bg-green-50 border-border" },
        { label: "Airtime GHS 5", status: "Delivered", color: "text-green-600 bg-green-50 border-border" },
        { label: "WAEC Voucher", status: "Pending", color: "text-yellow-600 bg-yellow-50 border-border" },
      ].map((o) => (
        <div key={o.label} className="bg-card border border-border rounded-lg px-2.5 py-1.5 flex items-center justify-between">
          <span className="text-[10px] font-medium text-foreground">{o.label}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${o.color}`}>{o.status}</span>
        </div>
      ))}
    </div>
  )
}

function MockVoucher() {
  return (
    <div className="p-3 bg-muted/40 text-center space-y-2">
      <div className="bg-card border-2 border-dashed border-border rounded-xl p-3">
        <GraduationCap className="w-6 h-6 text-primary mx-auto mb-1" />
        <p className="text-[10px] font-bold text-foreground">WAEC Results Checker</p>
        <p className="text-[10px] text-muted-foreground mt-1">PIN: <span className="font-mono font-bold text-foreground">****-****-****</span></p>
        <p className="text-[10px] text-muted-foreground">Serial: <span className="font-mono font-bold text-foreground">WEC2024****</span></p>
      </div>
      <p className="text-[10px] text-muted-foreground">Use on waecdirect.org</p>
    </div>
  )
}

function MockWithdrawal() {
  return (
    <div className="p-3 bg-muted/40 space-y-2">
      {/* Method selector */}
      <div className="flex gap-2">
        <div className="flex-1 border-2 border-primary bg-primary/5 rounded-lg p-2 text-center">
          <Phone className="w-3 h-3 text-primary mx-auto mb-0.5" />
          <p className="text-[9px] font-bold text-primary">Mobile Money</p>
        </div>
        <div className="flex-1 border border-border bg-card rounded-lg p-2 text-center">
          <Banknote className="w-3 h-3 text-muted-foreground mx-auto mb-0.5" />
          <p className="text-[9px] font-bold text-muted-foreground">Bank Transfer</p>
        </div>
      </div>

      {/* Amount + account */}
      <div className="bg-card border border-border rounded-lg px-2.5 py-1.5 flex items-center gap-2">
        <span className="text-[10px] font-bold text-muted-foreground">GHS</span>
        <span className="text-[11px] font-black text-foreground">50.00</span>
      </div>
      <div className="bg-card border border-border rounded-lg px-2.5 py-1.5">
        <p className="text-[10px] text-muted-foreground">0241234567 · MTN MoMo</p>
        <p className="text-[9px] text-green-600 font-semibold">✓ John Doe — Verified</p>
      </div>

      {/* Submit */}
      <div className="bg-gradient-to-r from-primary to-purple-600 rounded-lg py-1.5 text-center">
        <span className="text-[10px] font-bold text-white">Request Withdrawal</span>
      </div>

      {/* Status row */}
      <div className="bg-card border border-border rounded-lg px-2.5 py-1.5 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold text-foreground">GHS 50.00 → MoMo</p>
          <p className="text-[9px] text-muted-foreground">Requested · up to 3 business days</p>
        </div>
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-yellow-50 border border-border text-yellow-700">Pending</span>
      </div>
    </div>
  )
}

function MockInviteProcess() {
  return (
    <div className="p-3 bg-muted/40 space-y-2">
      {/* Step A — generate invite */}
      <div className="bg-card border border-border rounded-lg p-2.5 space-y-1.5">
        <p className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">Dashboard → Sub-Agents</p>
        <div className="flex gap-2">
          <div className="flex-1 bg-muted rounded px-2 py-1 text-[10px] text-muted-foreground">Phone (optional)</div>
          <div className="flex-1 bg-muted rounded px-2 py-1 text-[10px] text-muted-foreground">Email (optional)</div>
        </div>
        <div className="bg-gradient-to-r from-primary to-purple-600 rounded py-1 text-center">
          <span className="text-[10px] font-bold text-white">Generate Invite Link</span>
        </div>
      </div>

      {/* Step B — copy & share link */}
      <div className="bg-card border border-border rounded-lg p-2.5 space-y-1.5">
        <p className="text-[9px] font-bold text-green-600 uppercase tracking-widest">Invite Link Generated!</p>
        <div className="flex items-center gap-1.5 bg-green-50 border border-border rounded px-2 py-1">
          <Link2 className="w-3 h-3 text-green-600 flex-shrink-0" />
          <span className="text-[10px] text-foreground truncate font-mono">datagod.store/join/<span className="font-bold text-green-700">abc123</span></span>
          <Copy className="w-3 h-3 text-muted-foreground flex-shrink-0 ml-auto" />
        </div>
        <div className="flex gap-1.5">
          <div className="flex-1 bg-green-500 rounded py-1 text-center">
            <span className="text-[10px] font-bold text-white">Share on WhatsApp</span>
          </div>
          <div className="flex-1 bg-muted rounded py-1 flex items-center justify-center gap-1">
            <Mail className="w-3 h-3 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">Email</span>
          </div>
        </div>
      </div>

      {/* Step C — sub-agent joins */}
      <div className="bg-card border border-primary/20 rounded-lg p-2.5">
        <p className="text-[9px] font-bold text-primary uppercase tracking-widest mb-1">Sub-Agent Clicks Link</p>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-primary/10 rounded-full flex items-center justify-center flex-shrink-0">
            <UserPlus className="w-3 h-3 text-primary" />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-foreground">Registers their account</p>
            <p className="text-[9px] text-muted-foreground">Auto-linked to your shop ✓</p>
          </div>
          <CheckCircle2 className="w-4 h-4 text-green-500 ml-auto flex-shrink-0" />
        </div>
      </div>
    </div>
  )
}

function MockProfitMargin() {
  return (
    <div className="p-3 bg-muted/40 space-y-1.5">
      {[
        { size: "1GB MTN", base: "3.00", profit: "2.00", sell: "5.00" },
        { size: "3GB MTN", base: "8.00", profit: "4.00", sell: "12.00" },
      ].map((p) => (
        <div key={p.size} className="bg-card border border-border rounded-lg px-2.5 py-1.5 flex items-center gap-2">
          <span className="text-[10px] font-medium text-foreground flex-1">{p.size}</span>
          <span className="text-[9px] text-muted-foreground">Base GHS {p.base}</span>
          <span className="text-[9px] text-green-600 font-bold">+{p.profit}</span>
          <span className="text-[9px] font-black text-primary">= GHS {p.sell}</span>
        </div>
      ))}
    </div>
  )
}

export default function HomePage() {
  const { communityLink, loading: communityLoading } = useCommunityLink()

  const scrollToGuide = () => {
    document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Organization + Website Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: "DATAGOD",
            url: "https://www.datagod.store",
            description: "Buy affordable data packages from multiple networks with instant delivery",
            potentialAction: {
              "@type": "SearchAction",
              target: {
                "@type": "EntryPoint",
                urlTemplate: "https://www.datagod.store/shop?search={search_term_string}",
              },
              query_input: "required name=search_term_string",
            },
          }),
        }}
      />

      {/* Navigation */}
      <nav className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="bg-card p-2 rounded-lg">
            <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-6 h-6 rounded-lg object-cover" />
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-foreground">DATAGOD</h1>
        </div>
        <div className="flex flex-col gap-2 w-full sm:w-auto sm:flex-row sm:items-center sm:gap-4">
          <Link href="/auth/login">
            <Button variant="outline" className="w-full sm:w-auto">Sign In</Button>
          </Link>
          <Link href="/auth/signup">
            <Button className="bg-gradient-to-r from-primary to-purple-600 w-full sm:w-auto">
              Get Started
            </Button>
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-6xl mx-auto px-2 sm:px-6 py-8 sm:py-20">
        <div className="grid items-center gap-10 lg:grid-cols-2 mb-10 sm:mb-14">
          {/* Left: copy + CTAs */}
          <div className="text-center lg:text-left space-y-5">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
              <Zap className="h-3.5 w-3.5 text-primary" /> Instant delivery · all networks
            </span>
            <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-foreground leading-[1.1]">
              Buy data &amp; airtime in{" "}
              <span className="bg-gradient-to-r from-primary to-violet-600 bg-clip-text text-transparent">10 seconds.</span>
            </h2>
            <p className="text-base sm:text-lg text-muted-foreground max-w-xl mx-auto lg:mx-0">
              Instant bundles for MTN, Telecel and AT — pay from your wallet, or open your own shop and resell to earn. Built for Ghana.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
              <GuestPurchaseButton variant="secondary" className="w-full sm:w-auto" />
              <Link href="/auth/signup">
                <Button size="lg" className="gap-2 w-full sm:w-auto">
                  Get started
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <Button size="lg" variant="outline" className="w-full sm:w-auto gap-2" onClick={scrollToGuide}>
                How it works
                <ChevronDown className="w-4 h-4" />
              </Button>
            </div>
            {/* Trust stats */}
            <div className="flex justify-center lg:justify-start gap-8 pt-1">
              <div><div className="text-2xl font-extrabold text-foreground">3</div><div className="text-xs text-muted-foreground">networks</div></div>
              <div><div className="text-2xl font-extrabold text-foreground">500k+</div><div className="text-xs text-muted-foreground">orders delivered</div></div>
              <div><div className="text-2xl font-extrabold text-foreground">~8s</div><div className="text-xs text-muted-foreground">avg delivery</div></div>
            </div>
            {communityLoading ? (
              <div className="flex justify-center lg:justify-start">
                <Skeleton className="h-11 w-full sm:w-64 rounded-md" />
              </div>
            ) : communityLink ? (
              <a href={communityLink} target="_blank" rel="noopener noreferrer" className="flex justify-center lg:justify-start">
                <Button size="lg" className="w-full sm:w-auto gap-2 bg-green-600 hover:bg-green-700 text-white">
                  <MessageCircle className="w-4 h-4" />
                  Join Community
                </Button>
              </a>
            ) : null}
          </div>

          {/* Right: phone mockup */}
          <div className="hidden lg:flex justify-center">
            <div className="w-[300px] overflow-hidden rounded-[2.5rem] border-[10px] border-foreground/90 bg-background shadow-2xl">
              <div className="space-y-3 bg-muted/40 p-4">
                <div className="rounded-2xl bg-gradient-to-br from-primary to-violet-600 p-4 text-white">
                  <p className="text-xs font-medium opacity-85">Wallet Balance</p>
                  <p className="mt-1 text-2xl font-extrabold">GHS 1,240</p>
                  <div className="mt-3 flex gap-2">
                    <span className="rounded-md bg-white px-3 py-1 text-xs font-semibold text-violet-700">＋ Top Up</span>
                    <span className="rounded-md bg-white/20 px-3 py-1 text-xs font-semibold">Buy</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-border bg-card p-3"><div className="text-[10px] text-muted-foreground">Orders</div><div className="text-lg font-bold text-foreground">28</div></div>
                  <div className="rounded-xl border border-border bg-card p-3"><div className="text-[10px] text-muted-foreground">Done</div><div className="text-lg font-bold text-foreground">26</div></div>
                </div>
                <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-mtn text-mtn-foreground text-[10px] font-black">MTN</span>
                  <div className="flex-1"><div className="text-xs font-semibold text-foreground">MTN 5GB</div><div className="text-[10px] text-muted-foreground">GHS 24</div></div>
                  <span className="text-muted-foreground">→</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Network strip */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-10 sm:mb-16">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-bold text-foreground"><span className="grid h-5 w-5 place-items-center rounded bg-mtn text-mtn-foreground text-[10px] font-black">M</span> MTN</span>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-bold text-foreground"><span className="grid h-5 w-5 place-items-center rounded bg-telecel text-telecel-foreground text-[10px] font-black">T</span> Telecel</span>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-bold text-foreground"><span className="grid h-5 w-5 place-items-center rounded bg-at text-at-foreground text-[10px] font-black">A</span> AT iShare</span>
          <span className="rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground">+ Airtime · AFA · Results checker</span>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 mt-10 sm:mt-20">
          <div className="p-4 sm:p-6 bg-card rounded-lg shadow-sm border border-border hover:shadow-lg transition-shadow">
            <Package className="w-8 h-8 text-primary mb-4" />
            <h3 className="font-semibold text-foreground mb-2">Data Packages</h3>
            <p className="text-sm text-muted-foreground">
              Browse and purchase data packages from multiple networks
            </p>
          </div>
          <div className="p-4 sm:p-6 bg-card rounded-lg shadow-sm border border-border hover:shadow-lg transition-shadow">
            <Zap className="w-8 h-8 text-purple-600 mb-4" />
            <h3 className="font-semibold text-foreground mb-2">Instant Delivery</h3>
            <p className="text-sm text-muted-foreground">
              Get your data packages delivered instantly to your account
            </p>
          </div>
          <div className="p-4 sm:p-6 bg-card rounded-lg shadow-sm border border-border hover:shadow-lg transition-shadow">
            <Users className="w-8 h-8 text-green-600 mb-4" />
            <h3 className="font-semibold text-foreground mb-2">24/7 Support</h3>
            <p className="text-sm text-muted-foreground">
              Our support team is always available to help you
            </p>
          </div>
          <div className="p-4 sm:p-6 bg-card rounded-lg shadow-sm border border-border hover:shadow-lg transition-shadow">
            <Lock className="w-8 h-8 text-orange-600 mb-4" />
            <h3 className="font-semibold text-foreground mb-2">Secure & Safe</h3>
            <p className="text-sm text-muted-foreground">
              Your transactions are protected with industry-standard security
            </p>
          </div>
        </div>
      </section>

      {/* ── How It Works ────────────────────────────────────── */}
      <section id="how-it-works" className="bg-card border-t border-b border-border py-16 sm:py-24">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <span className="inline-block px-3 py-1 bg-primary/10 text-primary text-xs font-bold rounded-full uppercase tracking-wider mb-3">
              How It Works
            </span>
            <h2 className="text-2xl sm:text-4xl font-bold text-foreground mb-3">
              Everything you need, step by step
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto text-sm sm:text-base">
              Whether you're buying data for yourself, managing a dashboard, or running your own shop — we've got you covered.
            </p>
          </div>

          <Tabs defaultValue="guest" className="w-full">
            <TabsList className="grid grid-cols-3 w-full mb-10 h-auto">
              <TabsTrigger value="guest" className="flex flex-col gap-1 py-3 text-xs sm:text-sm">
                <ShoppingCart className="w-4 h-4" />
                <span>Buy from a Shop</span>
              </TabsTrigger>
              <TabsTrigger value="dashboard" className="flex flex-col gap-1 py-3 text-xs sm:text-sm">
                <Wallet className="w-4 h-4" />
                <span>Dashboard User</span>
              </TabsTrigger>
              <TabsTrigger value="agent" className="flex flex-col gap-1 py-3 text-xs sm:text-sm">
                <Store className="w-4 h-4" />
                <span>Open a Shop</span>
              </TabsTrigger>
            </TabsList>

            {/* ── Tab 1: Buy from a Shop (no login) ── */}
            <TabsContent value="guest">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-0">
                <div className="space-y-0">
                  <Step
                    number={1}
                    icon={<Share2 className="w-4 h-4" />}
                    title="Get a Shop Link"
                    description="Ask your seller for their storefront link (e.g. datagod.store/shop/their-shop), or follow a link shared on WhatsApp, social media, or a flyer. No account needed."
                  />
                  <Step
                    number={2}
                    icon={<Phone className="w-4 h-4" />}
                    title="Choose Your Network"
                    description="Tap your network — MTN, Telecel, AT-iShare, or AT-BigTime — to reveal available data plans."
                    mockup={<MockNetworkPicker />}
                  />
                  <Step
                    number={3}
                    icon={<Package className="w-4 h-4" />}
                    title="Pick a Package"
                    description="Select the data bundle that fits your needs. Prices are set by the shop owner and shown upfront — no hidden fees."
                    mockup={<MockPackageCard />}
                  />
                </div>
                <div className="space-y-0">
                  <Step
                    number={4}
                    icon={<ShoppingCart className="w-4 h-4" />}
                    title="Enter Your Details & Order"
                    description="Enter the recipient's phone number and your email address, then tap Order Now. Double-check the number — deliveries to wrong numbers cannot be reversed."
                    mockup={<MockCheckout />}
                  />
                  <Step
                    number={5}
                    icon={<CreditCard className="w-4 h-4" />}
                    title="Pay via Paystack"
                    description="You'll be taken to the secure Paystack checkout. Complete payment and stay on the page until you see the green confirmation screen."
                    mockup={<MockPaystack />}
                  />
                  <Step
                    number={6}
                    icon={<CheckCircle2 className="w-4 h-4" />}
                    title="Instant Delivery"
                    description="Your data is delivered to the entered number within seconds. Use the Track Order tab on the shop to check your order status anytime."
                    mockup={<MockSuccess />}
                  />
                </div>
              </div>
              <div className="mt-8 p-4 bg-amber-50 border border-border rounded-xl text-sm text-amber-800">
                <strong>Tip:</strong> You can also buy Airtime and WAEC/School Results Checker Vouchers from the same storefront — just tap the <em>Buy Airtime</em> or <em>Results Vouchers</em> tab at the top of the shop.
              </div>
            </TabsContent>

            {/* ── Tab 2: Dashboard User ── */}
            <TabsContent value="dashboard">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-0">
                <div className="space-y-0">
                  <Step
                    number={1}
                    icon={<UserPlus className="w-4 h-4" />}
                    title="Create a Free Account"
                    description="Sign up at datagod.store/auth/signup with your full name, phone number, and email. Check your email to verify your account."
                  />
                  <Step
                    number={2}
                    icon={<Wallet className="w-4 h-4" />}
                    title="Top Up Your Wallet"
                    description="Go to Dashboard → Wallet → Top Up. Pay via Paystack to load credit into your DATAGOD wallet instantly. A small platform fee applies."
                    mockup={<MockWallet />}
                  />
                  <Step
                    number={3}
                    icon={<Package className="w-4 h-4" />}
                    title="Buy Data Bundles"
                    description="Go to Buy Data, choose your network (MTN, Telecel, AT-iShare, AT-BigTime), pick a package, enter the recipient's number, and confirm. The cost is deducted from your wallet instantly."
                    mockup={<MockNetworkPicker />}
                  />
                </div>
                <div className="space-y-0">
                  <Step
                    number={4}
                    icon={<Zap className="w-4 h-4" />}
                    title="Buy Airtime"
                    description="Go to Buy Airtime, select the network, enter the amount and recipient number. Airtime is sent instantly and the amount is deducted from your wallet."
                  />
                  <Step
                    number={5}
                    icon={<GraduationCap className="w-4 h-4" />}
                    title="Get Results Checker Vouchers"
                    description="Go to Results Checker, choose your exam type (WAEC, BECE, etc.), and purchase. Your PIN and serial number are delivered instantly — use them on the exam body's official website."
                    mockup={<MockVoucher />}
                  />
                  <Step
                    number={6}
                    icon={<Search className="w-4 h-4" />}
                    title="Track All Your Orders"
                    description="Go to My Orders to see every purchase — data, airtime, and vouchers — with their status, date, and details. Contact support if an order doesn't arrive within 24 hours."
                    mockup={<MockTrackOrder />}
                  />
                </div>
              </div>
              <div className="mt-8 p-4 bg-primary/5 border border-primary/20 rounded-xl text-sm text-primary">
                <strong>Tip:</strong> Using your wallet is faster than paying per order — load credit once and buy multiple times without going through Paystack each time.
              </div>
            </TabsContent>

            {/* ── Tab 3: Open a Shop ── */}
            <TabsContent value="agent">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-0">
                <div className="space-y-0">
                  <Step
                    number={1}
                    icon={<UserPlus className="w-4 h-4" />}
                    title="Create & Verify Your Account"
                    description="Start by creating a free DATAGOD account at datagod.store/auth/signup. Verify your email before proceeding."
                  />
                  <Step
                    number={2}
                    icon={<TrendingUp className="w-4 h-4" />}
                    title="Upgrade to Agent or Dealer"
                    description="Go to Dashboard → Upgrade. Choose an Agent or Dealer subscription plan. Dealers get cheaper base prices, allowing higher profit margins."
                  />
                  <Step
                    number={3}
                    icon={<Store className="w-4 h-4" />}
                    title="Create Your Shop"
                    description="Go to Dashboard → My Shop → Create Shop. Set your shop name, a custom URL slug, description, logo, and your WhatsApp contact. This becomes your public storefront."
                  />
                </div>
                <div className="space-y-0">
                  <Step
                    number={4}
                    icon={<Settings className="w-4 h-4" />}
                    title="Set Packages & Profit Margins"
                    description="Enable the data packages you want to sell and set your profit margin on each one. Your selling price = base price + your margin. You keep the margin on every sale."
                    mockup={<MockProfitMargin />}
                  />
                  <Step
                    number={5}
                    icon={<Share2 className="w-4 h-4" />}
                    title="Share Your Shop Link"
                    description="Your shop is live at datagod.store/shop/your-slug. Share it on WhatsApp, social media, or print it on flyers. Customers can order directly — no login required for them."
                    mockup={<MockShopLink />}
                  />
                  <Step
                    number={6}
                    icon={<Banknote className="w-4 h-4" />}
                    title="Withdraw Your Earnings"
                    description={`Every sale made through your shop earns you your profit margin. Go to Dashboard → Shop Dashboard to see your accumulated balance.

To cash out, click Request Withdrawal. Choose your payout method — Mobile Money (MTN, Telecel, AT) or Bank Transfer. Enter your account number and the system will verify your account name before you confirm.

Withdrawals are subject to a small processing fee and are reviewed by the admin team. Approved funds are sent within 3 business days. You'll receive a notification when your withdrawal is approved or if more information is needed.`}
                    mockup={<MockWithdrawal />}
                  />
                  <Step
                    number={7}
                    icon={<Users className="w-4 h-4" />}
                    title="Invite Sub-Agents to Grow Your Network"
                    description={`Go to Dashboard → Sub-Agents → click "Invite Sub-Agent". Optionally enter the person's phone number or email (so the system can notify them), then click Generate Invite Link.

A unique link is created — e.g. datagod.store/join/abc123. Copy it and send it directly via WhatsApp, SMS, or email. The link expires after a set period so only your intended contact can use it.

When your sub-agent clicks the link, they see a branded invite page showing your shop name. They fill in their details and create their account — which is automatically linked to your shop. They then get their own storefront, set their own selling prices on top of your prices, and their customers order from them directly. You earn on every package they sell.`}
                    mockup={<MockInviteProcess />}
                  />
                </div>
              </div>
              <div className="mt-8 p-4 bg-purple-50 border border-border rounded-xl text-sm text-purple-800">
                <strong>Tip:</strong> Keep your WhatsApp number visible on your shop — customers trust sellers they can message directly. Use the Shop Settings page to configure your WhatsApp link.
              </div>
            </TabsContent>
          </Tabs>

          <div className="mt-12 text-center">
            <p className="text-muted-foreground text-sm mb-4">Ready to get started?</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/auth/signup">
                <Button className="bg-gradient-to-r from-primary to-purple-600 gap-2 w-full sm:w-auto">
                  Create Free Account
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="bg-gradient-to-r from-primary to-purple-600 text-white py-8 sm:py-16 mt-0">
        <div className="max-w-4xl mx-auto px-2 sm:px-6 text-center space-y-4 sm:space-y-6">
          <h2 className="text-xl sm:text-3xl md:text-4xl font-bold">Ready to Get Started?</h2>
          <p className="text-sm sm:text-lg text-primary-foreground/80">
            Join thousands of users who trust DATAGOD for their data needs
          </p>
          <Link href="/auth/signup">
            <Button size="lg" className="bg-card text-primary hover:bg-accent w-full sm:w-auto">
              Create Your Account
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-muted-foreground py-8 sm:py-12">
        <div className="max-w-6xl mx-auto px-2 sm:px-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 sm:gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Lock className="w-5 h-5 text-blue-400" />
                <span className="font-semibold text-white">DATAGOD</span>
              </div>
              <p className="text-sm">Your trusted data hub solution</p>
            </div>
            <div>
              <h4 className="font-semibold text-white mb-4">Product</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="#how-it-works" className="hover:text-white">How It Works</a></li>
                <li><a href="#how-it-works" className="hover:text-white">Features</a></li>
                <li><a href="#how-it-works" className="hover:text-white">Pricing</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white mb-4">Company</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="#" className="hover:text-white">About</a></li>
                <li><a href="#" className="hover:text-white">Blog</a></li>
                <li><a href="#" className="hover:text-white">Contact</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white mb-4">Legal</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="/privacy" className="hover:text-white">Privacy</a></li>
                <li><a href="/terms" className="hover:text-white">Terms</a></li>
                <li><a href="#" className="hover:text-white">Cookies</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-800 pt-8 text-center text-sm">
            <p>&copy; 2025 DATAGOD. All rights reserved.</p>
          </div>
        </div>
      </footer>
      <HomeAIChatWidget />
    </div>
  )
}
