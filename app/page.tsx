"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Package, Zap, Users, ArrowRight, Lock,
  ShoppingCart, Wallet, GraduationCap, Store,
  CheckCircle2, CreditCard, Phone, UserPlus,
  TrendingUp, Share2, Settings, Search, Link2, Copy, Mail, Banknote, MessageCircle,
  Cpu, Hash, Globe, Smartphone, Code2, Database, Send, FileCheck2,
  Rocket, ShieldCheck, Facebook, Twitter, Instagram, Receipt, Monitor, Gem, HelpCircle, Headset,
} from "lucide-react"
import GuestPurchaseButton from "@/components/GuestPurchaseButton"
import { HomeAIChatWidget } from "@/components/home/AIChatWidget"
import { useCommunityLink } from "@/hooks/use-community-link"
import { Skeleton } from "@/components/ui/skeleton"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { isPageHidden } from "@/lib/custom-domains"
import { StorefrontServicesCarousel, type StorefrontCarouselSlide } from "@/components/shop/StorefrontServicesCarousel"

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
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center shadow">
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
          { name: "AT-BigTime", color: "bg-primary" },
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
      <div className="bg-primary rounded-lg py-1.5 text-center">
        <span className="text-[11px] font-bold text-primary-foreground">Order Now — GHS 5.00</span>
      </div>
    </div>
  )
}

function MockPaystack() {
  return (
    <div className="p-3 bg-muted/40 text-center space-y-2">
      <div className="inline-flex items-center gap-1.5 bg-card border border-border rounded-full px-3 py-1 shadow-sm">
        <Lock className="w-3 h-3 text-success" />
        <span className="text-[10px] font-semibold text-foreground">Secured by Paystack</span>
      </div>
      <div className="bg-card border border-border rounded-lg p-2 flex items-center gap-2">
        <CreditCard className="w-4 h-4 text-muted-foreground" />
        <div className="flex-1 h-2 bg-muted rounded" />
        <span className="text-[10px] text-muted-foreground">****</span>
      </div>
      <p className="text-[10px] text-warning font-semibold">⚠ Do not close this tab until confirmed</p>
    </div>
  )
}

function MockSuccess() {
  return (
    <div className="p-4 bg-success/10 text-center space-y-1">
      <CheckCircle2 className="w-8 h-8 text-success mx-auto" />
      <p className="text-xs font-bold text-success">Data Delivered!</p>
      <p className="text-[10px] text-success">1GB sent to 0201234567</p>
    </div>
  )
}

function MockWallet() {
  return (
    <div className="p-3 bg-muted/40 space-y-2">
      <div className="bg-primary rounded-xl p-3 text-primary-foreground">
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
        <Store className="w-3 h-3 text-primary flex-shrink-0" />
        <span className="text-[11px] text-muted-foreground truncate">datagod.store/shop/<span className="font-bold text-primary">your-shop</span></span>
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
        { label: "3GB MTN Data", status: "Delivered", color: "text-success bg-success/10 border-border" },
        { label: "Airtime GHS 5", status: "Delivered", color: "text-success bg-success/10 border-border" },
        { label: "WAEC Voucher", status: "Pending", color: "text-warning bg-warning/10 border-border" },
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
        <p className="text-[9px] text-success font-semibold">✓ John Doe — Verified</p>
      </div>

      {/* Submit */}
      <div className="bg-primary rounded-lg py-1.5 text-center">
        <span className="text-[10px] font-bold text-primary-foreground">Request Withdrawal</span>
      </div>

      {/* Status row */}
      <div className="bg-card border border-border rounded-lg px-2.5 py-1.5 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold text-foreground">GHS 50.00 → MoMo</p>
          <p className="text-[9px] text-muted-foreground">Requested · up to 3 business days</p>
        </div>
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-warning/10 border border-border text-warning">Pending</span>
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
        <div className="bg-primary rounded py-1 text-center">
          <span className="text-[10px] font-bold text-primary-foreground">Generate Invite Link</span>
        </div>
      </div>

      {/* Step B — copy & share link */}
      <div className="bg-card border border-border rounded-lg p-2.5 space-y-1.5">
        <p className="text-[9px] font-bold text-success uppercase tracking-widest">Invite Link Generated!</p>
        <div className="flex items-center gap-1.5 bg-success/10 border border-border rounded px-2 py-1">
          <Link2 className="w-3 h-3 text-success flex-shrink-0" />
          <span className="text-[10px] text-foreground truncate font-mono">datagod.store/join/<span className="font-bold text-success">abc123</span></span>
          <Copy className="w-3 h-3 text-muted-foreground flex-shrink-0 ml-auto" />
        </div>
        <div className="flex gap-1.5">
          <div className="flex-1 bg-success rounded py-1 text-center">
            <span className="text-[10px] font-bold text-success-foreground">Share on WhatsApp</span>
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
          <CheckCircle2 className="w-4 h-4 text-success ml-auto flex-shrink-0" />
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
          <span className="text-[9px] text-success font-bold">+{p.profit}</span>
          <span className="text-[9px] font-black text-primary">= GHS {p.sell}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Services & Benefits data ─────────────────────────── */

// `color` = icon-badge pastel pair (bg/text), cycled per card so the grid
// reads as a varied set of products rather than one flat brand-colored wall
// — matches the reference's per-card accent-color pattern.
const TOP_SERVICES = [
  { icon: Database, title: "Data Bundles", desc: "High-speed MTN, Telecel & AT data bundles at the best rates, delivered in seconds.", tag: null, color: "bg-emerald-100 text-emerald-600" },
  { icon: Zap, title: "Airtime Topup", desc: "Instant airtime recharge for any network, paid straight from your wallet.", tag: null, color: "bg-blue-100 text-blue-600" },
  { icon: UserPlus, title: "AFA Registration", desc: "Register AFA / iShare numbers instantly — no queues, no paperwork.", tag: null, color: "bg-purple-100 text-purple-600" },
  { icon: FileCheck2, title: "Results Checker", desc: "WASSCE, BECE & NovDec PINs delivered instantly so you can check your own results.", tag: null, color: "bg-amber-100 text-amber-600" },
  { icon: Search, title: "Results Check Service", desc: "No PIN to spare? We check your results for you and send them by email & WhatsApp.", tag: null, color: "bg-cyan-100 text-cyan-600" },
  { icon: Send, title: "Bulk SMS", desc: "Send OTPs, alerts and campaigns with your own sender ID, address book & templates.", tag: null, color: "bg-rose-100 text-rose-600" },
  { icon: Store, title: "Reseller Shops", desc: "Launch your own branded storefront and set your own profit margins.", tag: "RESELL", color: "bg-indigo-100 text-indigo-600" },
  { icon: Users, title: "Sub-Agent Program", desc: "Recruit sellers under your shop and earn commission on everything they sell.", tag: null, color: "bg-teal-100 text-teal-600" },
] as const

// Real, upcoming roadmap items — not live yet. Kept visually distinct (own
// section, muted/dashed cards) from TOP_SERVICES so visitors never mistake
// something unreleased for something they can buy today.
const COMING_SOON = [
  { icon: Receipt, title: "Bill Pay", desc: "Pay ECG, Ghana Water, and other utility bills instantly from your wallet." },
  { icon: Monitor, title: "Website & App Development", desc: "Custom websites, online stores and mobile apps for businesses across Ghana — built and kept running by our team." },
] as const

const WHY_CHOOSE = [
  { icon: Rocket, title: "Ultra-Fast Delivery", desc: "Data and airtime orders are processed and delivered in seconds, not minutes.", color: "bg-orange-100 text-orange-600" },
  { icon: Cpu, title: "AI Assistants Everywhere", desc: "One AI, tuned for every surface — web, WhatsApp, your shop storefront, and your dashboard.", color: "bg-violet-100 text-violet-600" },
  { icon: ShieldCheck, title: "Secure Wallet Payments", desc: "Pay from your wallet through Paystack-secured checkout, with a clear transaction trail.", color: "bg-emerald-100 text-emerald-600" },
  { icon: Globe, title: "Order From Anywhere", desc: "Web storefront, WhatsApp bot, or USSD with no internet needed — or install DATAGOD as an app.", color: "bg-sky-100 text-sky-600" },
  { icon: Code2, title: "Developer API", desc: "Integrate automated data and airtime purchases directly into your own app or system.", color: "bg-indigo-100 text-indigo-600" },
  { icon: Banknote, title: "Instant Withdrawals", desc: "Cash out your reseller profits to Mobile Money or bank, with verified, tracked payouts.", color: "bg-rose-100 text-rose-600" },
] as const

// Factual answers to real, already-documented platform behavior — no
// invented policies or numbers.
const FAQ_ITEMS = [
  { q: "How fast is delivery?", a: "Most data and airtime orders are delivered within seconds of payment confirming — our average is around 8 seconds. During very high traffic it can take a few minutes." },
  { q: "How do I pay?", a: "Guests pay per order via Paystack (card or Mobile Money). Account holders can also load a wallet once and buy repeatedly without going through Paystack each time." },
  { q: "What happens if I enter the wrong number?", a: "Data and airtime deliveries to an incorrect recipient number cannot be reversed — always double-check the number before confirming your order." },
  { q: "Can I resell data and earn?", a: "Yes. Upgrade to an Agent or Dealer plan, open your own branded shop, set your own profit margin on top of the base price, and withdraw your earnings to Mobile Money or bank." },
  { q: "Do I need an account to buy?", a: "No — you can buy directly from any reseller's shop link as a guest, no account required. An account is only needed to use a wallet, track order history in one place, or open your own shop." },
  { q: "How do I get support?", a: "Chat with us on WhatsApp for instant help, or file and track a complaint from your dashboard if you have an account." },
] as const

interface PublicPackage {
  id?: string
  network: string
  size: string
  price: number
}

interface SubscriptionPlan {
  id: string
  name: string
  description: string
  price: string
  duration_days: number
}

export default function HomePage() {
  const { communityLink, loading: communityLoading } = useCommunityLink()
  const domainBranding = useDomainBranding()
  const router = useRouter()

  // Live, real pricing — never hardcoded, so this never goes stale or gets
  // mistaken for fabricated numbers. "default" is the platform's own
  // retail-pricing shop slug, same one app/dashboard/data-packages/page.tsx
  // already fetches from.
  const [popularPackages, setPopularPackages] = useState<PublicPackage[]>([])
  const [plans, setPlans] = useState<SubscriptionPlan[]>([])
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  useEffect(() => {
    fetch("/api/shop/public-packages?slug=default", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data?.packages)) setPopularPackages(data.packages)
      })
      .catch(() => {})
    fetch("/api/subscriptions/plans")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (Array.isArray(data?.plans)) setPlans(data.plans)
      })
      .catch(() => {})
  }, [])

  // One representative (cheapest) package per network, for a compact
  // "Popular Data Packages" preview — still real, live data, just curated
  // down from the full catalog rather than dumping every size.
  const popularByNetwork = Object.values(
    popularPackages.reduce((acc, pkg) => {
      if (!acc[pkg.network] || pkg.price < acc[pkg.network].price) acc[pkg.network] = pkg
      return acc
    }, {} as Record<string, PublicPackage>)
  ).slice(0, 6)

  const dealerPlan = plans.find((p) => /diamond|lifetime/i.test(p.name))
  const termPlans = plans.filter((p) => p !== dealerPlan)

  return (
    <div className="min-h-screen bg-background">
      {/* Organization + Website Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          // domainBranding.siteName is admin-only input, but JSON.stringify does
          // not escape "</script>" — the .replace neutralizes a literal
          // "</script>" breakout attempt without altering how the JSON parses
          // (a standard, safe technique: < is a valid JSON escape for "<").
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: domainBranding.siteName || "DATAGOD",
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
          }).replace(/</g, "\\u003c"),
        }}
      />

      {/* Navigation */}
      <nav className="sticky top-0 z-50 flex items-center justify-between px-4 sm:px-6 py-4 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="flex items-center gap-3">
          {domainBranding.logoUrl ? (
            <img src={domainBranding.logoUrl} alt={`${domainBranding.siteName || "DATAGOD"} logo`} className="h-7 w-7 rounded-lg object-cover" />
          ) : (
            <div aria-hidden className="h-7 w-7 rounded-lg bg-gradient-to-br from-primary to-brand-accent" />
          )}
          <h1 className="text-lg sm:text-xl font-display font-semibold text-foreground tracking-tight">{domainBranding.siteName || "DATAGOD"}</h1>
        </div>
        <div className="hidden md:flex items-center gap-6">
          {[
            ["Networks", "#networks"],
            ["Services", "#services"],
            ["Why Us", "#why-us"],
            ["How it works", "#how-it-works"],
            ["Shops", "/join"],
          ].map(([l, href]) => (
            <a key={l} href={href} className="font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">{l}</a>
          ))}
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/auth/login"><Button variant="ghost" className="font-display">Sign In</Button></Link>
          <Link href="/auth/signup"><Button className="font-display">Get Started</Button></Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-6xl mx-auto px-2 sm:px-6 py-8 sm:py-20">
        {/* Metric bar */}
        <div className="mb-8 flex flex-wrap gap-x-7 gap-y-2 border-b border-border pb-5 font-mono text-[11px] text-muted-foreground">
          <span>Delivery <span className="text-primary">~8s</span></span>
          <span>Uptime <span className="text-primary">99.99%</span></span>
          <span>Orders <span className="text-primary">500,000+</span></span>
          <span>AI <span className="text-primary">5 assistants</span></span>
        </div>
        <div className="relative grid items-center gap-10 lg:grid-cols-2">
          {/* ambient grid + glow */}
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 opacity-30 [mask-image:radial-gradient(circle_at_75%_0,#000,transparent_72%)]"
               style={{ backgroundImage: "linear-gradient(hsl(var(--border)) 1px,transparent 1px),linear-gradient(90deg,hsl(var(--border)) 1px,transparent 1px)", backgroundSize: "36px 36px" }} />
          {/* Left: copy */}
          <div className="text-center lg:text-left">
            <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-primary mb-4">
              <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_10px_hsl(var(--primary))]" /> Ghana's all-in-one data & reseller platform
            </span>
            <h2 className="font-display text-3xl sm:text-5xl font-semibold tracking-tight text-foreground leading-[1.04]">
              Data, airtime &amp; more —{" "}
              <span className="bg-gradient-to-r from-primary to-brand-accent bg-clip-text text-transparent">delivered in 10 seconds.</span>
            </h2>
            <p className="mt-4 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto lg:mx-0">
              Data, airtime, AFA, results checkers &amp; bulk SMS — pay from your wallet, or open your own branded shop and earn reselling to others. Built for Ghana.
            </p>
            <div className="mt-5 flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
              <Link href="/auth/signup"><Button size="lg" className="gap-2 w-full sm:w-auto">Get started <ArrowRight className="w-4 h-4" /></Button></Link>
              {!isPageHidden("guest_purchase", domainBranding.hiddenPages) && (
                <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
              )}
            </div>
            <div className="mt-6 flex justify-center lg:justify-start gap-8">
              <div><div className="font-display text-2xl font-bold text-foreground">3</div><div className="text-xs text-muted-foreground">networks</div></div>
              <div><div className="font-display text-2xl font-bold text-foreground">500k+</div><div className="text-xs text-muted-foreground">orders delivered</div></div>
              <div><div className="font-display text-2xl font-bold text-foreground">~8s</div><div className="text-xs text-muted-foreground">avg delivery</div></div>
            </div>
            {!isPageHidden("join_channel", domainBranding.hiddenPages) && (
              communityLoading ? (
                <div className="mt-5 flex justify-center lg:justify-start"><Skeleton className="h-11 w-full sm:w-56 rounded-md" /></div>
              ) : communityLink ? (
                <a href={communityLink} target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 font-display text-sm font-semibold text-primary hover:bg-primary/15 transition-colors">
                  <MessageCircle className="w-4 h-4" /> Join Community
                </a>
              ) : null
            )}
          </div>
          {/* Right: AI assistants card */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-display text-sm font-semibold text-foreground"><Cpu className="w-[18px] h-[18px] text-primary" /> DATAGOD AI</div>
              <span className="flex items-center gap-1.5 font-mono text-[9px] text-primary"><span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />ONLINE</span>
            </div>
            <p className="mt-1 mb-3 text-[11px] text-muted-foreground">One assistant — tuned for every surface you use.</p>
            {[
              ["WEB", "Browse plans, track any order, explain dealer pricing."],
              ["SHOP", "Find bundles & start checkout for you."],
              ["WHATSAPP", "Order by chat, re-verify stuck top-ups, file complaints."],
              ["DEALER", "“Buy 5GB MTN for 024…”, today’s sales, manage USSD."],
              ["ADMIN", "Fulfil orders & manage users, shops & payouts by chat."],
            ].map(([tag, txt]) => (
              <div key={tag} className="flex gap-3 border-t border-border py-2">
                <div className="w-16 shrink-0 font-mono text-[9px] leading-snug text-primary">{tag}</div>
                <div className="text-[11px] text-muted-foreground">{txt}</div>
              </div>
            ))}
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
              <span className="flex-1 text-[11px] text-muted-foreground">Ask DATAGOD anything…</span>
              <span className="grid h-[22px] w-[22px] place-items-center rounded-md bg-primary text-primary-foreground"><ArrowRight className="w-3 h-3" /></span>
            </div>
          </div>
        </div>

        {/* Network strip */}
        <div id="networks" className="mt-10 flex flex-wrap items-center justify-center gap-3 sm:mt-14">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-bold text-foreground"><span className="grid h-5 w-5 place-items-center rounded bg-mtn text-mtn-foreground text-[10px] font-black">M</span> MTN</span>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-bold text-foreground"><span className="grid h-5 w-5 place-items-center rounded bg-telecel text-telecel-foreground text-[10px] font-black">T</span> Telecel</span>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-bold text-foreground"><span className="grid h-5 w-5 place-items-center rounded bg-at text-at-foreground text-[10px] font-black">A</span> AT iShare</span>
          <span className="rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground">+ Airtime · AFA · Results checker</span>
        </div>
      </section>

      {/* ── Promo Carousel ───────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 sm:pb-14">
        <StorefrontServicesCarousel
          slides={[
            {
              key: "data", badge: "DATA & AIRTIME", title: "Buy Data & Airtime Instantly",
              description: "MTN, Telecel & AT bundles delivered in seconds — pay from your wallet.",
              cta: "Get Started", icon: Database, gradient: "from-[#0f172a] to-[#2563eb]",
              onClick: () => router.push("/auth/signup"),
            },
            {
              key: "shop", badge: "RESELL", title: "Launch Your Own Reseller Shop",
              description: "A branded storefront with your name, logo, and your own prices — live in minutes.",
              cta: "Open Your Shop", icon: Store, gradient: "from-[#052e16] to-[#059669]",
              onClick: () => router.push("/auth/signup"),
            },
            {
              key: "sms", badge: "BULK SMS", title: "Send SMS at Scale",
              description: "OTPs, alerts and campaigns with your own sender ID, templates & address book.",
              cta: "Get Started", icon: Send, gradient: "from-[#431407] to-[#d97706]",
              onClick: () => router.push("/auth/signup"),
            },
            {
              key: "channels", badge: "EVERYWHERE", title: "Order From Anywhere",
              description: "Web, WhatsApp, USSD, or our Developer API — however you prefer to order.",
              cta: "Explore", icon: Globe, gradient: "from-[#1e1b4b] to-[#4f46e5]",
              onClick: () => document.getElementById("services")?.scrollIntoView({ behavior: "smooth" }),
            },
          ] satisfies StorefrontCarouselSlide[]}
        />
      </section>

      {/* ── Our Top Services ────────────────────────────────── */}
      <section id="services" className="bg-card border-t border-b border-border py-16 sm:py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">Proven Products</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-3">Our Top Services</h2>
            <p className="text-muted-foreground max-w-xl mx-auto text-sm sm:text-base">
              Everything you need to buy, resell, and manage digital services in one place.
            </p>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            {TOP_SERVICES.map(({ icon: Icon, title, desc, tag, color }) => (
              <div key={title} className="rounded-2xl border-2 border-foreground/80 bg-background p-4 sm:p-6">
                <div className={`mb-4 grid h-12 w-12 place-items-center rounded-2xl ${color}`}><Icon className="h-[22px] w-[22px]" /></div>
                <h3 className="mb-1.5 flex items-center gap-2 font-display font-bold text-foreground">{title}{tag && <span className="rounded-full border border-primary/30 px-1.5 py-0.5 font-mono text-[8px] text-primary">{tag}</span>}</h3>
                <p className="text-sm text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>

          {/* Roadmap — kept visually separate (dashed, muted) so it's never
              mistaken for something buyable today. */}
          <div className="mt-10 flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Coming soon<span className="h-px flex-1 bg-border" />
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            {COMING_SOON.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="rounded-2xl border-2 border-dashed border-border bg-background/60 p-5 sm:p-6 opacity-80">
                <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-border bg-muted"><Icon className="h-[22px] w-[22px] text-muted-foreground" /></div>
                <h3 className="mb-1.5 flex items-center gap-2 font-display font-bold text-foreground">{title}<span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-[8px] text-muted-foreground">COMING SOON</span></h3>
                <p className="text-sm text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Branded Reseller Shop ────────────────────────────── */}
      <section className="py-16 sm:py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 grid lg:grid-cols-2 gap-10 items-center">
          <div>
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">Reseller Tools</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-4">Launch your own branded storefront</h2>
            <p className="text-muted-foreground mb-6">
              Your name, your logo, your prices. Create a shop in minutes and start earning a profit margin on every sale — no coding, no setup fees.
            </p>
            <ul className="space-y-3 mb-6">
              {["Your own name, logo & brand colors", "Set your own profit margin on every package", "No login required for your customers", "Share your link on WhatsApp, social media, or flyers"].map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-foreground">
                  <CheckCircle2 className="w-4 h-4 text-success mt-0.5 flex-shrink-0" /> {item}
                </li>
              ))}
            </ul>
            <Link href="/auth/signup"><Button size="lg" className="gap-2">Open Your Shop <ArrowRight className="w-4 h-4" /></Button></Link>
          </div>
          <div className="rounded-2xl border-2 border-foreground/80 bg-card shadow-sm overflow-hidden">
            <MockShopLink />
            <div className="border-t border-border">
              <MockProfitMargin />
            </div>
          </div>
        </div>
      </section>

      {/* ── See It In Action (real storefront, via Buy as Guest) ── */}
      {!isPageHidden("guest_purchase", domainBranding.hiddenPages) && (
        <section className="py-16 sm:py-20">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 text-center">
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">See It In Action</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-3">Try a real storefront — no account needed</h2>
            <p className="text-muted-foreground text-sm sm:text-base mb-8">
              Before you build your own shop, see exactly what your customers will experience — browse packages and check out as a guest.
            </p>
            <div className="flex justify-center">
              <GuestPurchaseButton variant="primary" />
            </div>
          </div>
        </section>
      )}

      {/* ── Developer API ────────────────────────────────────── */}
      <section className="bg-card border-t border-b border-border py-16 sm:py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 grid lg:grid-cols-2 gap-10 items-center">
          <div className="order-2 lg:order-1 rounded-2xl border-2 border-foreground/80 bg-background shadow-sm overflow-hidden p-4 font-mono text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1.5 mb-3">
              <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" /><span className="h-2.5 w-2.5 rounded-full bg-warning/60" /><span className="h-2.5 w-2.5 rounded-full bg-success/60" />
            </div>
            <p><span className="text-primary">POST</span> /api/v1/orders</p>
            <p className="text-foreground/60">X-API-Key: YOUR_API_KEY</p>
            <p className="mt-2">{"{"}</p>
            <p className="pl-3">"network": "MTN",</p>
            <p className="pl-3">"volume_gb": 1,</p>
            <p className="pl-3">"recipient": "0241234567",</p>
            <p className="pl-3">"reference": "ORDER-REF-001"</p>
            <p>{"}"}</p>
            <p className="mt-2 text-success">→ 200 OK — delivered</p>
          </div>
          <div className="order-1 lg:order-2">
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">For Developers</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-4">Integrate data &amp; airtime into your own app</h2>
            <p className="text-muted-foreground mb-6">
              Automate data bundle and airtime purchases directly from your own website, app, or system — get your API key from the dashboard and start building.
            </p>
            <ul className="space-y-3 mb-6">
              {["Simple REST API — no SDK required", "Get your API key straight from the dashboard", "Automate data bundle & airtime purchases", "Built for Ghanaian apps & platforms"].map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-foreground">
                  <CheckCircle2 className="w-4 h-4 text-success mt-0.5 flex-shrink-0" /> {item}
                </li>
              ))}
            </ul>
            <Link href="/auth/signup"><Button size="lg" variant="outline" className="gap-2">Get API Access <ArrowRight className="w-4 h-4" /></Button></Link>
          </div>
        </div>
      </section>

      {/* ── Pay With Your Wallet ─────────────────────────────── */}
      <section className="py-16 sm:py-24">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">Wallet</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-3">Pay With Your Wallet</h2>
            <p className="text-muted-foreground max-w-xl mx-auto text-sm sm:text-base">Load credit once, then buy instantly — no card details needed every time.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            {[
              { icon: CreditCard, title: "Top Up", desc: "Fund your wallet via Paystack — card or Mobile Money." },
              { icon: Wallet, title: "Store Balance", desc: "Your balance is ready whenever you want to buy." },
              { icon: Zap, title: "Buy Instantly", desc: "Pick a package and confirm — no checkout, no delay." },
            ].map(({ icon: Icon, title, desc }, i) => (
              <div key={title} className="rounded-2xl border-2 border-foreground/80 bg-card p-5 sm:p-6">
                <div className="mb-4 flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-primary text-primary-foreground text-sm font-bold">{i + 1}</span>
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="mb-1.5 font-display font-bold text-foreground">{title}</h3>
                <p className="text-sm text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Why Choose Datagod ──────────────────────────────── */}
      <section id="why-us" className="py-16 sm:py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">Why Choose Us</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-3">Why Choose {domainBranding.siteName || "DATAGOD"}?</h2>
            <p className="text-muted-foreground max-w-xl mx-auto text-sm sm:text-base">
              The fastest, most flexible way to buy and resell digital services in Ghana.
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
            {WHY_CHOOSE.map(({ icon: Icon, title, desc, color }) => (
              <div key={title} className="rounded-2xl border-2 border-foreground/80 bg-card p-5 sm:p-6">
                <div className={`mb-4 grid h-12 w-12 place-items-center rounded-2xl ${color}`}><Icon className="h-[22px] w-[22px]" /></div>
                <h3 className="mb-1.5 font-display font-bold text-foreground">{title}</h3>
                <p className="text-sm text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Bulk SMS ──────────────────────────────────────────── */}
      <section className="bg-card border-t border-b border-border py-16 sm:py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 grid lg:grid-cols-2 gap-10 items-center">
          <div>
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">Bulk SMS</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-4">Send SMS to your customers — at scale</h2>
            <p className="text-muted-foreground mb-6">
              OTPs, alerts, and marketing campaigns — sent in seconds, from your own sender ID.
            </p>
            <ul className="space-y-3 mb-6">
              {["Your own approved sender ID", "Address book & reusable templates", "OTPs, alerts, and bulk campaigns", "Delivery reports for every send"].map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-foreground">
                  <CheckCircle2 className="w-4 h-4 text-success mt-0.5 flex-shrink-0" /> {item}
                </li>
              ))}
            </ul>
            <Link href="/auth/signup"><Button size="lg" className="gap-2">Get Started <ArrowRight className="w-4 h-4" /></Button></Link>
          </div>
          <div className="rounded-2xl border-2 border-foreground/80 bg-background p-5 shadow-sm">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-3">Delivery Report</p>
            <div className="space-y-2">
              {[{ label: "OTP campaign", sent: 240, delivered: 238 }, { label: "Promo blast", sent: 1500, delivered: 1486 }, { label: "Order alert", sent: 1, delivered: 1 }].map((r) => (
                <div key={r.label} className="bg-card border border-border rounded-lg px-3 py-2 flex items-center justify-between text-xs">
                  <span className="font-medium text-foreground">{r.label}</span>
                  <span className="text-success font-bold">{r.delivered}/{r.sent} delivered</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── AFA Field Agent ──────────────────────────────────── */}
      <section className="py-16 sm:py-24">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 text-center">
          <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">AFA Registration</span>
          <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-3">Become an Authorized Field Agent</h2>
          <p className="text-muted-foreground text-sm sm:text-base mb-8">
            Register AFA / iShare numbers for your community — no queues, no paperwork, done right from your dashboard.
          </p>
          <Link href="/auth/signup"><Button size="lg" className="gap-2">Register Now <ArrowRight className="w-4 h-4" /></Button></Link>
        </div>
      </section>

      {/* ── Agent Membership Plans & Dealer Tier (live pricing) ── */}
      {plans.length > 0 && (
        <section className="bg-card border-t border-b border-border py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="text-center mb-12">
              <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">Pricing</span>
              <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-3">Agent Membership Plans</h2>
              <p className="text-muted-foreground max-w-xl mx-auto text-sm sm:text-base">Upgrade to unlock wholesale pricing and open your own shop.</p>
            </div>
            {termPlans.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
                {termPlans.map((plan) => (
                  <div key={plan.id} className="rounded-2xl border-2 border-foreground/80 bg-background p-5 sm:p-6">
                    <h3 className="font-display font-bold text-foreground mb-1">{plan.name.trim()}</h3>
                    <p className="text-2xl font-black text-foreground mb-1">GHS {Number(plan.price).toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground mb-3">{plan.duration_days} day{plan.duration_days === 1 ? "" : "s"} access</p>
                    {plan.description && <p className="text-sm text-muted-foreground mb-4">{plan.description}</p>}
                    <Link href="/auth/signup"><Button variant="outline" className="w-full">Choose Plan</Button></Link>
                  </div>
                ))}
              </div>
            )}
            {dealerPlan && (
              <div className="rounded-2xl border-2 border-primary bg-gradient-to-br from-primary/5 to-brand-accent/5 p-5 sm:p-6 flex flex-col sm:flex-row items-center gap-5 justify-between">
                <div className="flex items-center gap-4">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 flex-shrink-0"><Gem className="h-[22px] w-[22px] text-primary" /></div>
                  <div>
                    <h3 className="font-display font-bold text-foreground">Dealer Tier — {dealerPlan.name.trim()}</h3>
                    <p className="text-sm text-muted-foreground">{dealerPlan.description || "Our best wholesale pricing, unlocked for life."}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 flex-shrink-0">
                  <p className="text-2xl font-black text-foreground">GHS {Number(dealerPlan.price).toFixed(2)}</p>
                  <Link href="/auth/signup"><Button className="gap-2">Become a Dealer <ArrowRight className="w-4 h-4" /></Button></Link>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── How It Works ────────────────────────────────────── */}
      <section id="how-it-works" className="bg-card border-t border-b border-border py-16 sm:py-24">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">How It Works</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-3">
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
              <div className="mt-8 p-4 bg-warning/10 border border-border rounded-xl text-sm text-warning">
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
              <div className="mt-8 p-4 bg-primary/10 border border-border rounded-xl text-sm text-primary">
                <strong>Tip:</strong> Keep your WhatsApp number visible on your shop — customers trust sellers they can message directly. Use the Shop Settings page to configure your WhatsApp link.
              </div>
            </TabsContent>
          </Tabs>

          <div className="mt-12 text-center">
            <p className="text-muted-foreground text-sm mb-4">Ready to get started?</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/auth/signup">
                <Button className="gap-2 w-full sm:w-auto">
                  Create Free Account
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              {!isPageHidden("guest_purchase", domainBranding.hiddenPages) && (
                <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── Popular Data Packages (live pricing) ─────────────── */}
      {popularByNetwork.length > 0 && (
        <section className="bg-card border-t border-b border-border py-16 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="text-center mb-12">
              <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">Live Pricing</span>
              <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-3">Popular Data Packages</h2>
              <p className="text-muted-foreground max-w-xl mx-auto text-sm sm:text-base">Real retail prices, pulled straight from our live catalog.</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
              {popularByNetwork.map((pkg) => (
                <div key={`${pkg.network}-${pkg.size}`} className="rounded-2xl border-2 border-foreground/80 bg-background p-4 text-center">
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1">{pkg.network}</p>
                  <p className="text-xl font-black text-foreground">{pkg.size}</p>
                  <p className="text-sm font-bold text-primary mt-1">GHS {Number(pkg.price).toFixed(2)}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 text-center">
              <Link href="/auth/signup"><Button size="lg" className="gap-2">See All Packages <ArrowRight className="w-4 h-4" /></Button></Link>
            </div>
          </div>
        </section>
      )}

      {/* ── Social Proof ──────────────────────────────────────── */}
      <section className="bg-card border-t border-b border-border py-14 sm:py-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            {[
              { icon: Users, label: "Customers Served", value: "26,000+" },
              { icon: Package, label: "Orders Delivered", value: "500,000+" },
              { icon: Zap, label: "Avg Delivery", value: "~8s" },
              { icon: ShieldCheck, label: "Uptime", value: "99.99%" },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="rounded-2xl border-2 border-foreground/80 bg-background p-4 sm:p-6 text-center">
                <Icon className="w-5 h-5 text-primary mx-auto mb-2" />
                <p className="font-display text-xl sm:text-3xl font-black text-foreground">{value}</p>
                <p className="text-xs text-muted-foreground mt-1">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Easy Support & Complaint Resolution ──────────────── */}
      <section className="py-16 sm:py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 grid sm:grid-cols-2 gap-3 sm:gap-4">
          <div className="rounded-2xl border-2 border-foreground/80 bg-card p-5 sm:p-6">
            <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-emerald-100 text-emerald-600"><Headset className="h-[22px] w-[22px]" /></div>
            <h3 className="mb-1.5 font-display font-bold text-foreground">Direct WhatsApp Support</h3>
            <p className="text-sm text-muted-foreground mb-4">Chat with us directly for help with an order, a payment, or anything else.</p>
            <Link href="/whatsapp"><Button variant="outline" className="gap-2">Chat Now <ArrowRight className="w-4 h-4" /></Button></Link>
          </div>
          <div className="rounded-2xl border-2 border-foreground/80 bg-card p-5 sm:p-6">
            <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-blue-100 text-blue-600"><FileCheck2 className="h-[22px] w-[22px]" /></div>
            <h3 className="mb-1.5 font-display font-bold text-foreground">Track Your Complaints</h3>
            <p className="text-sm text-muted-foreground mb-4">File a complaint and track it from start to resolution, right from your dashboard.</p>
            <Link href="/auth/signup"><Button variant="outline" className="gap-2">Create Account <ArrowRight className="w-4 h-4" /></Button></Link>
          </div>
        </div>
      </section>

      {/* ── FAQ ───────────────────────────────────────────────── */}
      <section className="bg-card border-t border-b border-border py-16 sm:py-24">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">FAQ</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-foreground mb-3">Frequently Asked Questions</h2>
          </div>
          <div className="space-y-3">
            {FAQ_ITEMS.map((item, i) => (
              <div key={item.q} className="rounded-2xl border-2 border-foreground/80 bg-background overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full flex items-center justify-between gap-3 p-4 sm:p-5 text-left"
                >
                  <span className="flex items-center gap-2.5 font-display font-semibold text-foreground"><HelpCircle className="w-4 h-4 text-primary flex-shrink-0" /> {item.q}</span>
                  <ArrowRight className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${openFaq === i ? "rotate-90" : ""}`} />
                </button>
                {openFaq === i && (
                  <p className="px-4 sm:px-5 pb-4 sm:pb-5 text-sm text-muted-foreground">{item.a}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Help & Live Community ───────────────────────────── */}
      <section className="relative py-16 sm:py-20"
               style={{ backgroundImage: "radial-gradient(600px 300px at 50% 0, hsl(var(--primary) / 0.12), transparent 70%)" }}>
        <div className="max-w-xl mx-auto px-4 sm:px-6 text-center">
          {/* Centered brand mark */}
          <div className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full border border-border bg-card shadow-sm">
            {domainBranding.logoUrl ? (
              <img src={domainBranding.logoUrl} alt={`${domainBranding.siteName || "DATAGOD"} logo`} className="h-12 w-12 rounded-full object-cover" />
            ) : (
              <div aria-hidden className="h-12 w-12 rounded-full bg-gradient-to-br from-primary to-brand-accent" />
            )}
          </div>
          <p className="font-display text-lg font-bold text-foreground">{domainBranding.siteName || "DATAGOD"}</p>
          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-1.5 text-xs font-semibold text-foreground shadow-sm">
            <Zap className="w-3.5 h-3.5 text-primary" /> Instant Delivery, Always
          </span>

          {/* Card */}
          <div className="mt-8 rounded-3xl border border-border bg-card p-6 sm:p-8 shadow-md text-left sm:text-center">
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">Support & Resources</span>
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-foreground mb-3">Help & Live Community</h2>
            <p className="text-muted-foreground text-sm sm:text-base mb-6">
              Get direct support by chat, track your complaints, and connect with other resellers inside our community.
            </p>
            <div className="flex flex-col gap-3">
              <Link href="/whatsapp" className="w-full">
                <Button size="lg" className="gap-2 w-full rounded-full">
                  <MessageCircle className="w-4 h-4" /> Chat on WhatsApp
                </Button>
              </Link>
              {!isPageHidden("join_channel", domainBranding.hiddenPages) && (
                communityLoading ? (
                  <Skeleton className="h-11 w-full rounded-full" />
                ) : communityLink ? (
                  <a href={communityLink} target="_blank" rel="noopener noreferrer" className="w-full">
                    <Button size="lg" className="gap-2 w-full rounded-full bg-brand-accent text-primary-foreground hover:bg-brand-accent/90">
                      <Users className="w-4 h-4" /> Join Community
                    </Button>
                  </a>
                ) : null
              )}
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="relative border-t border-border py-12 sm:py-16 text-center"
               style={{ backgroundImage: "radial-gradient(500px 200px at 50% 0, hsl(var(--primary) / 0.16), transparent 70%)" }}>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 space-y-4 sm:space-y-6">
          <h2 className="font-display text-2xl sm:text-3xl md:text-4xl font-semibold text-foreground">Ready to get started?</h2>
          <p className="text-sm sm:text-lg text-muted-foreground">Join thousands who trust {domainBranding.siteName || "DATAGOD"} for data, airtime &amp; more.</p>
          <Link href="/auth/signup"><Button size="lg" className="w-full sm:w-auto">Create your free account</Button></Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-footer text-muted-foreground py-10 sm:py-12 border-t border-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6 sm:gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-3">
                {domainBranding.logoUrl ? (
                  <img src={domainBranding.logoUrl} alt={`${domainBranding.siteName || "DATAGOD"} logo`} className="h-5 w-5 rounded object-cover" />
                ) : (
                  <div aria-hidden className="h-5 w-5 rounded bg-gradient-to-br from-primary to-brand-accent" />
                )}
                <span className="font-display font-semibold text-foreground">{domainBranding.siteName || "DATAGOD"}</span>
              </div>
              <p className="text-sm mb-4">Your trusted data hub for Ghana — data, airtime, AFA, vouchers &amp; SMS.</p>
              {!domainBranding.siteName && (
                <div className="flex items-center gap-3">
                  <a href="https://web.facebook.com/datagod.store" target="_blank" rel="noopener noreferrer" aria-label="Facebook" className="text-muted-foreground hover:text-foreground transition-colors"><Facebook className="w-4 h-4" /></a>
                  <a href="https://twitter.com/datagodstore" target="_blank" rel="noopener noreferrer" aria-label="Twitter" className="text-muted-foreground hover:text-foreground transition-colors"><Twitter className="w-4 h-4" /></a>
                  <a href="https://www.instagram.com/datagodstore" target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="text-muted-foreground hover:text-foreground transition-colors"><Instagram className="w-4 h-4" /></a>
                </div>
              )}
            </div>
            <div>
              <h4 className="mb-4 font-mono text-[11px] uppercase tracking-wider text-foreground/80">Product</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="#services" className="hover:text-foreground">Our Services</a></li>
                <li><a href="#why-us" className="hover:text-foreground">Why Choose Us</a></li>
                <li><a href="#how-it-works" className="hover:text-foreground">How It Works</a></li>
              </ul>
            </div>
            <div>
              <h4 className="mb-4 font-mono text-[11px] uppercase tracking-wider text-foreground/80">Resources</h4>
              <ul className="space-y-2 text-sm">
                <li><Link href="/whatsapp" className="hover:text-foreground">Order via WhatsApp</Link></li>
                <li><Link href="/results-checker" className="hover:text-foreground">Results Checker</Link></li>
                <li><Link href="/join" className="hover:text-foreground">Shops & Sub-Agents</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="mb-4 font-mono text-[11px] uppercase tracking-wider text-foreground/80">Legal</h4>
              <ul className="space-y-2 text-sm">
                <li><Link href="/privacy" className="hover:text-foreground">Privacy Policy</Link></li>
                <li><Link href="/terms" className="hover:text-foreground">Terms of Service</Link></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-border pt-8 text-center text-sm">
            <p>&copy; 2026 {domainBranding.siteName || "DATAGOD"}. All rights reserved.</p>
          </div>
        </div>
      </footer>
      <HomeAIChatWidget />
    </div>
  )
}
