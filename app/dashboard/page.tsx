"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { useAuth } from "@/hooks/use-auth"
import { useOnboarding } from "@/hooks/use-onboarding"
import { useUserRole } from "@/hooks/use-user-role"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { WalletOnboardingModal } from "@/components/onboarding/wallet-onboarding-modal"
import { PhoneVerifyModal } from "@/components/phone-verify-modal"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  TrendingUp, CheckCircle, AlertCircle, Clock, Loader2,
  Store, Users, Send, IdCard, Wallet as WalletIcon, Smartphone, ArrowRight, ChevronLeft, ChevronRight, Grid3x3, BarChart3,
  type LucideIcon,
} from "lucide-react"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { supabase } from "@/lib/supabase"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { getServicePrimaryPath } from "@/lib/custom-domains"
import { LatestOrderCard } from "@/components/dashboard/latest-order-card"
import { NetworkHealthCard, NETWORK_BADGE } from "@/components/dashboard/network-health-card"
// Type-only: order-health-service.ts pulls in mtn-hold.ts -> sms-service.ts
// -> push-service.ts -> web-push (raw Node net/tls sockets) at runtime. A
// value import (e.g. its HEALTH_NETWORKS const) would drag that whole chain
// into this client bundle and fail the build ("Module not found: Can't
// resolve 'net'"), so the network list below is instead derived from
// NETWORK_BADGE's keys, which lives in the client-safe network-health-card.
import type { LatestOrderSummary, NetworkHealthStat, HealthNetwork } from "@/lib/order-health-service"

// Real Datagod services (not Apex Prime's Academic Writing / Apple Music /
// Merchant SIM tiles, which don't apply to this platform). Each service gets
// its own gradient + accent color, matching the reference (a navy card for
// "Website & App Development", a green one for "Result Checkers" -- every
// service has its own colour, not one shared card color).
const PROMO_SERVICES: {
  badge: string
  title: string
  description: string
  cta: string
  href: string
  icon: LucideIcon
  gradient: string
  textColor: string
}[] = [
  {
    badge: "STOREFRONT", title: "Own Shop", cta: "Launch Shop",
    description: "Launch your white-label storefront and sell under your own brand.",
    href: "/dashboard/my-shop", icon: Store,
    gradient: "from-[#3b0764] to-[#7c3aed]", textColor: "text-[#6d28d9]",
  },
  {
    badge: "BOT", title: "USSD / WhatsApp Bot", cta: "Set Up Bot",
    description: "Sell data, airtime and results checks through your own automated bot.",
    href: "/dashboard/ussd-shop", icon: Smartphone,
    gradient: "from-[#042f2e] to-[#0d9488]", textColor: "text-[#0f766e]",
  },
  {
    badge: "NETWORK", title: "Sub-Agents", cta: "Recruit Agents",
    description: "Recruit sellers under you and earn on every sale they make.",
    href: "/dashboard/sub-agents", icon: Users,
    gradient: "from-[#431407] to-[#d97706]", textColor: "text-[#b45309]",
  },
  {
    badge: "MESSAGING", title: "Bulk SMS", cta: "Send SMS",
    description: "Send SMS campaigns to your customers at scale.",
    href: "/dashboard/sms", icon: Send,
    gradient: "from-[#0f172a] to-[#2563eb]", textColor: "text-[#1d4ed8]",
  },
  {
    badge: "EDUCATION", title: "AFA Registration", cta: "Register Now",
    description: "Register and manage AFA orders for your customers.",
    href: "/dashboard/afa-orders", icon: IdCard,
    gradient: "from-[#052e16] to-[#059669]", textColor: "text-[#047857]",
  },
  {
    badge: "WALLET", title: "Wallet Top Up", cta: "Top Up Now",
    description: "Fund your wallet instantly to keep buying without delay.",
    href: "/dashboard/wallet", icon: WalletIcon,
    gradient: "from-[#1e1b4b] to-[#4f46e5]", textColor: "text-[#4338ca]",
  },
]

// Bar colors for the 7-Day Send Activity chart, matching this app's real
// network brand hues (same family as bg-mtn/bg-telecel/bg-at) rather than a
// generic chart palette. Recharts needs literal color strings, not classes.
const CHART_COLORS: Record<HealthNetwork, string> = {
  MTN: "#FFCC00",
  Telecel: "#E00018",
  "AT - iShare": "#0B57D0",
  "AT - BigTime": "#7C3AED",
}

// Format large numbers with K/M suffix
const formatCount = (num: number | string): string => {
  const n = typeof num === 'string' ? parseInt(num, 10) : num
  if (isNaN(n)) return String(num)
  if (n >= 1000000) {
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (n >= 10000) {
    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return n.toLocaleString()
}

function BannerStat({ icon: Icon, value, label }: { icon: LucideIcon; value: string; label: string }) {
  return (
    <div className="rounded-xl bg-white/12 p-3 text-center">
      <Icon className="mx-auto h-4 w-4 text-white/80" />
      <p className="mt-1.5 text-lg font-extrabold text-white tabular-nums">{value}</p>
      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70">{label}</p>
    </div>
  )
}

interface DashboardStats {
  totalOrders: number
  completed: number
  processing: number
  failed: number
  pending: number
  successRate: string
}

interface RecentActivity {
  id: string
  description: string
  amount: number
  type: "credit" | "debit"
  timestamp: string
}

interface SendActivityDay {
  date: string
  label: string
  counts: Record<HealthNetwork, number>
}

export default function DashboardPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const { showOnboarding, completeOnboarding, isLoading: onboardingLoading } = useOnboarding()
  const { isDealer } = useUserRole()
  const domainBranding = useDomainBranding()
  const primaryService = domainBranding.services?.[0] ?? null
  const [firstName, setFirstName] = useState("")
  const [userEmail, setUserEmail] = useState("")
  const [joinDate, setJoinDate] = useState("")
  const [userRole, setUserRole] = useState<string | null>(null)
  const [isSubAgent, setIsSubAgent] = useState<boolean | null>(null) // null = checking, true/false = checked
  const [stats, setStats] = useState<DashboardStats>({
    totalOrders: 0,
    completed: 0,
    processing: 0,
    failed: 0,
    pending: 0,
    successRate: "0%"
  })
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([])
  const [showPhoneVerify, setShowPhoneVerify] = useState(false)
  const [currentPhone, setCurrentPhone] = useState("")
  const [phoneVerifyDeadline, setPhoneVerifyDeadline] = useState<string | null>(null)
  const [latestOrder, setLatestOrder] = useState<LatestOrderSummary | null>(null)
  const [latestOrderLoading, setLatestOrderLoading] = useState(true)
  const [networkHealth, setNetworkHealth] = useState<NetworkHealthStat[]>([])
  const [networkHealthLoading, setNetworkHealthLoading] = useState(true)
  const [sendActivity, setSendActivity] = useState<SendActivityDay[]>([])
  const [promoIndex, setPromoIndex] = useState(0)
  const promoScrollRef = useRef<HTMLDivElement>(null)

  // Check if user is a sub-agent and redirect immediately.
  // Timeout after 5s so a slow/hanging Supabase query never permanently
  // blocks the dashboard behind a spinner.
  useEffect(() => {
    const checkSubAgent = async () => {
      if (!user) return

      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5000)
        )
        const query = supabase
          .from("user_shops")
          .select("id, parent_shop_id")
          .eq("user_id", user.id)
          .single()

        const { data: userShop } = await Promise.race([query, timeout])

        if (userShop?.parent_shop_id) {
          router.replace("/dashboard/buy-stock")
          return
        }

        setIsSubAgent(false)
      } catch {
        // Query error, timeout, or no shop found — not a sub-agent, proceed
        setIsSubAgent(false)
      }
    }

    if (user && !authLoading) {
      checkSubAgent()
    }
  }, [user, authLoading, router])

  // Auth protection - redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[DASHBOARD] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    loadDashboardData()
    // Fire-and-forget background order status check (now authenticated)
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.access_token) return
        await fetch("/api/orders/check-status", {
          method: "GET",
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
      } catch { /* silent — background task */ }
    })()
  }, [user])

  // Scrolls the carousel track to a given card with a smooth-scroll
  // animation, used by the dot buttons below.
  const scrollPromoTo = (index: number) => {
    const el = promoScrollRef.current
    if (el) el.scrollTo({ left: index * el.clientWidth, behavior: "smooth" })
    setPromoIndex(index)
  }

  // Advance the promo carousel automatically with the same smooth-scroll
  // animation, not a content swap — swiping the track manually (see
  // handlePromoScroll below) keeps promoIndex in sync either way.
  useEffect(() => {
    const interval = setInterval(() => {
      setPromoIndex((i) => {
        const next = (i + 1) % PROMO_SERVICES.length
        const el = promoScrollRef.current
        if (el) el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" })
        return next
      })
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  // Keeps the active dot in sync when the person swipes/drags the track by hand.
  const handlePromoScroll = () => {
    const el = promoScrollRef.current
    if (!el || el.clientWidth === 0) return
    setPromoIndex(Math.round(el.scrollLeft / el.clientWidth))
  }

  const fetchLatestOrder = async (token: string) => {
    setLatestOrderLoading(true)
    try {
      const res = await fetch("/api/dashboard/latest-order", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
      const d = res.ok ? await res.json() : null
      if (d?.success) setLatestOrder(d.order)
    } catch { /* silent — card shows its own empty state */ }
    finally { setLatestOrderLoading(false) }
  }

  const fetchNetworkHealth = async (token: string) => {
    setNetworkHealthLoading(true)
    try {
      const res = await fetch("/api/dashboard/network-health", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
      const d = res.ok ? await res.json() : null
      if (d?.success) setNetworkHealth(d.networks || [])
    } catch { /* silent — card shows its own empty state */ }
    finally { setNetworkHealthLoading(false) }
  }

  const fetchSendActivity = async (token: string) => {
    try {
      const res = await fetch("/api/dashboard/send-activity", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
      const d = res.ok ? await res.json() : null
      if (d?.success) setSendActivity(d.days || [])
    } catch { /* silent — chart shows its own empty state */ }
  }

  const refreshWithFreshToken = async (fetcher: (token: string) => Promise<void>) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) await fetcher(session.access_token)
  }

  // Keep the order-health cards live without requiring a manual refresh or
  // full page reload: refetch when the tab regains focus/visibility (the
  // common case — place an order elsewhere, come back to an already-open
  // dashboard tab) and on a periodic interval while the tab stays visible.
  useEffect(() => {
    if (!user) return

    const refreshOrderHealth = () => {
      refreshWithFreshToken(fetchLatestOrder)
      refreshWithFreshToken(fetchNetworkHealth)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshOrderHealth()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener("focus", refreshOrderHealth)
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refreshOrderHealth()
    }, 60_000)

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("focus", refreshOrderHealth)
      clearInterval(interval)
    }
  }, [user])

  const loadDashboardData = async () => {
    try {
      // Get session once, then fan out all fetches in parallel
      const [{ data: { user: authUser } }, { data: { session } }] = await Promise.all([
        supabase.auth.getUser(),
        supabase.auth.getSession(),
      ])

      const token = session?.access_token

      await Promise.allSettled([
        // User profile + name
        (async () => {
          if (!authUser?.id) return
          setUserEmail(authUser.email || "")

          // The dashboard NEVER redirects to complete-profile. New users (no DB
          // profile) are routed to /auth/complete-profile by the auth callback
          // (service-role check) BEFORE they reach here, and their row is created
          // there. Existing users land here; no-phone ones are handled by the global
          // PhoneRequiredModal in DashboardLayout. Removing the old redirect kills
          // the loop that happened when the client-side (RLS) read returned no row
          // while the callback's service-role read saw it.
          const { data: profile } = await supabase
            .from("users")
            .select("first_name, last_name, role, phone_number")
            .eq("id", authUser.id)
            .single()

          const name = profile?.last_name || profile?.first_name || authUser.email?.split("@")[0] || "User"
          setFirstName(name.charAt(0).toUpperCase() + name.slice(1))
          setUserRole(profile?.role || "user")

          // Optional: check phone_verified (only if migration 0053 was run)
          try {
            const { data: extProfile } = await supabase
              .from("users")
              .select("phone_verified, phone_verify_deadline")
              .eq("id", authUser.id)
              .single()
            // Soft reminder ONLY during the grace window. After the deadline (or
            // with no deadline) the global non-dismissable PhoneRequiredModal in
            // the layout takes over as the hard block, so the two never overlap.
            const inGrace = extProfile?.phone_verify_deadline
              && new Date(extProfile.phone_verify_deadline) > new Date()
            if (extProfile && profile?.phone_number && !extProfile.phone_verified && inGrace) {
              setCurrentPhone(profile.phone_number)
              setPhoneVerifyDeadline(extProfile.phone_verify_deadline ?? null)
              setShowPhoneVerify(true)
            }
          } catch { /* columns not yet migrated — skip */ }

          if (authUser.created_at) {
            const diffDays = Math.ceil(Math.abs(Date.now() - new Date(authUser.created_at).getTime()) / 86400000)
            if (diffDays < 1) setJoinDate("Today")
            else if (diffDays < 7) setJoinDate(`${diffDays} days ago`)
            else if (diffDays < 30) setJoinDate(`${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? "s" : ""} ago`)
            else if (diffDays < 365) setJoinDate(`${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) > 1 ? "s" : ""} ago`)
            else setJoinDate(`${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) > 1 ? "s" : ""} ago`)
          }
        })(),

        // Dashboard stats
        token
          ? fetch("/api/dashboard/stats", { headers: { Authorization: `Bearer ${token}` } })
              .then(r => r.ok ? r.json() : null)
              .then(d => { if (d?.success) setStats(d.stats) })
          : Promise.resolve(),

        // Recent transactions
        token
          ? fetch("/api/transactions/list?limit=3", { headers: { Authorization: `Bearer ${token}` } })
              .then(r => r.ok ? r.json() : null)
              .then(d => {
                if (!d) return
                setRecentActivity((d.transactions || []).map((txn: any) => ({
                  id: txn.id,
                  description: txn.description,
                  amount: txn.amount,
                  type: txn.type,
                  timestamp: txn.created_at,
                })))
              })
          : Promise.resolve(),

        // Latest completed order (real order-history trust widget)
        token
          ? fetchLatestOrder(token)
          : Promise.resolve(setLatestOrderLoading(false)),

        // Platform-wide network health (real, computed from order history)
        token
          ? fetchNetworkHealth(token)
          : Promise.resolve(setNetworkHealthLoading(false)),

        // This account's own last-7-days send activity by network
        token
          ? fetchSendActivity(token)
          : Promise.resolve(),
      ])
    } catch {
      // silent — individual settled results handle their own errors
    }
  }

  // Show loading state while checking authentication or sub-agent status
  if (authLoading || (user && isSubAgent === null)) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    )
  }

  // Redirect happens in useEffect, but render nothing while waiting
  if (!user) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    )
  }

  const getGreeting = () => {
    const hour = new Date().getHours()
    if (hour < 12) return "Good Morning"
    if (hour < 18) return "Good Afternoon"
    return "Good Evening"
  }

  const chartData = sendActivity.map((d) => ({ label: d.label, ...d.counts }))
  const activeNetworks = (Object.keys(NETWORK_BADGE) as HealthNetwork[]).filter((n) =>
    sendActivity.some((d) => d.counts[n] > 0)
  )
  const legendNetworks = activeNetworks.length > 0 ? activeNetworks : (Object.keys(NETWORK_BADGE) as HealthNetwork[])

  return (
    <DashboardLayout>
      <WalletOnboardingModal
        open={showOnboarding && !onboardingLoading}
        onComplete={completeOnboarding}
      />
      <PhoneVerifyModal
        open={showPhoneVerify}
        currentPhone={currentPhone}
        deadline={phoneVerifyDeadline ?? undefined}
        onVerified={() => setShowPhoneVerify(false)}
        onDismiss={() => setShowPhoneVerify(false)}
      />
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-[#1e2537]">{getGreeting()}, {firstName}</h1>
          <p className="mt-0.5 text-sm text-[#6b7280]">
            {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
          </p>
        </div>

        {/* First card: account meta (Role / Member Since) plus a live
            Pending/Processing/Completed/Failed order-status grid — colors
            match the reference's own navy gradient rather than this app's
            --primary token. */}
        <div className="rounded-2xl bg-gradient-to-br from-[#1b388b] to-[#2a5ce8] p-5">
          <div className="flex items-center justify-between gap-4 border-b border-white/15 pb-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-white/60">Role</p>
              <p className="mt-0.5 text-sm font-bold text-white">{isDealer ? "Authorized Dealer" : "Premium Agent"}</p>
            </div>
            <div className="h-8 w-px bg-white/15" />
            <div className="text-right">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-white/60">Member Since</p>
              <p className="mt-0.5 text-sm font-bold text-white">{joinDate || "Recently"}</p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2.5">
            <BannerStat icon={Clock} value={formatCount(stats.pending)} label="Pending" />
            <BannerStat icon={TrendingUp} value={formatCount(stats.processing)} label="Processing" />
            <BannerStat icon={CheckCircle} value={formatCount(stats.completed)} label="Completed" />
            <BannerStat icon={AlertCircle} value={formatCount(stats.failed)} label="Failed" />
          </div>

          <div className="mt-4 border-t border-white/15 pt-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-white/60">Quick Actions</p>
            <div className="flex flex-wrap gap-2">
              {(!domainBranding.services || domainBranding.services.includes("data_bundles")) && (
                <Button onClick={() => router.push("/dashboard/data-packages")} className="bg-white text-[#1b388b] hover:bg-white/90 font-semibold">
                  Buy Data Package
                </Button>
              )}
              {(!domainBranding.services || domainBranding.services.includes("airtime")) && (
                <Button onClick={() => router.push("/dashboard/airtime")} className="bg-white/15 text-white hover:bg-white/25 border-0 font-semibold">
                  Buy Airtime
                </Button>
              )}
              {domainBranding.services?.includes("results_checker") && (
                <Button onClick={() => router.push("/dashboard/results-checker")} className="bg-white/15 text-white hover:bg-white/25 border-0 font-semibold">
                  Check Results
                </Button>
              )}
              {domainBranding.services?.includes("bulk_sms") && (
                <Button onClick={() => router.push("/dashboard/sms")} className="bg-white/15 text-white hover:bg-white/25 border-0 font-semibold">
                  Buy SMS
                </Button>
              )}
              {!domainBranding.services && (
                <Button onClick={() => router.push("/dashboard/my-shop")} className="bg-white/15 text-white hover:bg-white/25 border-0 font-semibold">
                  Create Shop
                </Button>
              )}
              {(!domainBranding.services || domainBranding.services.includes("data_bundles")) && (
                <Button onClick={() => router.push("/dashboard/data-packages?mode=bulk")} className="bg-white/15 text-white hover:bg-white/25 border-0 font-semibold">
                  Bulk Order
                </Button>
              )}
              <Button onClick={() => router.push("/dashboard/my-orders")} className="bg-white/15 text-white hover:bg-white/25 border-0 font-semibold">
                My Orders
              </Button>
              <Button onClick={() => router.push("/dashboard/wallet")} className="bg-white/15 text-white hover:bg-white/25 border-0 font-semibold">
                ＋ Top Up
              </Button>
            </div>
          </div>
        </div>

        {/* Promo carousel — Datagod's real services, not Apex Prime's
            irrelevant tiles (Academic Writing, Apple Music/iCloud, Merchant
            SIM Onboarding). Every service gets its own gradient (the
            reference uses a different color per card, not one shared blue),
            plus decorative glow circles and left/right arrow buttons on top
            of the real horizontally-scrollable, swipeable track. */}
        <div className="relative">
          <div
            ref={promoScrollRef}
            onScroll={handlePromoScroll}
            className="flex overflow-x-auto snap-x snap-mandatory scroll-smooth rounded-2xl [&::-webkit-scrollbar]:hidden"
            style={{ scrollbarWidth: "none" }}
          >
            {PROMO_SERVICES.map((svc) => (
              <button
                key={svc.title}
                onClick={() => router.push(svc.href)}
                className={`relative block w-full shrink-0 snap-start overflow-hidden rounded-2xl bg-gradient-to-br ${svc.gradient} p-5 pr-28 text-left sm:pr-36`}
              >
                <span className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
                <span className="pointer-events-none absolute -bottom-10 left-16 h-28 w-28 rounded-full bg-white/5 blur-xl" />
                {/* Large, vertically-centered accent icon -- not a small
                    top-corner badge; matches the reference's proportions.
                    Inset far enough right that it never overlaps the
                    left/right nav arrows below. */}
                <span className="absolute right-12 top-1/2 flex h-16 w-16 -translate-y-1/2 items-center justify-center rounded-2xl border border-white/20 bg-white/15 text-white sm:right-16 sm:h-20 sm:w-20">
                  <svc.icon className="h-7 w-7 sm:h-9 sm:w-9" />
                </span>
                <span className="relative inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-white">
                  <svc.icon className="h-3.5 w-3.5" /> {svc.badge}
                </span>
                <p className="relative mt-4 text-lg font-bold text-white">{svc.title}</p>
                <p className="relative mt-1 max-w-md text-sm text-white/80">{svc.description}</p>
                <span className={`relative mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-bold ${svc.textColor}`}>
                  {svc.cta} <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </button>
            ))}
          </div>

          <button
            type="button"
            aria-label="Previous service"
            onClick={() => scrollPromoTo((promoIndex - 1 + PROMO_SERVICES.length) % PROMO_SERVICES.length)}
            className="absolute left-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/25 text-white hover:bg-black/40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next service"
            onClick={() => scrollPromoTo((promoIndex + 1) % PROMO_SERVICES.length)}
            className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/25 text-white hover:bg-black/40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="-mt-3 flex justify-center gap-1.5">
          {PROMO_SERVICES.map((svc, i) => (
            <button
              key={svc.title}
              aria-label={`Show ${svc.title}`}
              onClick={() => scrollPromoTo(i)}
              className={`h-1.5 rounded-full transition-all ${i === promoIndex ? "w-5 bg-[#235cd4]" : "w-1.5 bg-[#d1d5db]"}`}
            />
          ))}
        </div>

        {/* SEND DATA BUNDLES — network shortcuts. Network + name only; the
            reference's "24H VOLUME" per-network figure isn't something this
            platform currently computes, so it's omitted rather than made up. */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Grid3x3 className="h-4 w-4 text-[#1e2537]" />
            <p className="text-xs font-extrabold uppercase tracking-wide text-[#1e2537]">Send Data Bundles</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(Object.keys(NETWORK_BADGE) as HealthNetwork[]).map((net) => {
              const badge = NETWORK_BADGE[net]
              return (
                <button
                  key={net}
                  onClick={() => router.push(primaryService ? getServicePrimaryPath(primaryService) : "/dashboard/data-packages")}
                  className="flex flex-col items-center gap-2 rounded-2xl border border-[#eef0f5] bg-white p-4 text-center transition hover:border-[#1b388b]/30 hover:shadow-sm"
                >
                  <span className={`flex h-12 w-12 items-center justify-center rounded-full text-xs font-extrabold ${badge.className}`}>
                    {badge.text}
                  </span>
                  <span className="text-xs font-bold text-[#1e2537]">{net}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Latest completed order: real, computed trust widget — no fabricated numbers */}
        <LatestOrderCard
          order={latestOrder}
          loading={latestOrderLoading}
          onRefresh={() => refreshWithFreshToken(fetchLatestOrder)}
        />

        {/* Network health: real, computed — no fabricated numbers */}
        <NetworkHealthCard
          networks={networkHealth}
          loading={networkHealthLoading}
          onRefresh={() => refreshWithFreshToken(fetchNetworkHealth)}
        />

        {/* 7-Day Send Activity — this account's own completed orders per day
            per network over the last 7 days (personal activity, unlike the
            platform-wide Network Health section above). */}
        <div className="rounded-2xl border border-[#e5e9f5] bg-white p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#eef2ff] text-[#235cd4]">
                <BarChart3 className="h-4 w-4" />
              </span>
              <p className="text-[15px] font-bold text-[#1e2537]">7-Day Send Activity</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {legendNetworks.map((n) => (
                <span key={n} className="flex items-center gap-1.5 text-xs font-semibold text-[#4b5563]">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CHART_COLORS[n] }} />
                  {n}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-4 h-[220px]">
            {chartData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-[#6b7280]">Loading...</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barGap={2} barCategoryGap="24%">
                  <CartesianGrid vertical={false} stroke="#eef0f5" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#6b7280" }} />
                  <YAxis tickLine={false} axisLine={false} width={28} tick={{ fontSize: 11, fill: "#6b7280" }} allowDecimals={false} />
                  <Tooltip cursor={{ fill: "rgba(27,56,139,0.04)" }} />
                  {legendNetworks.map((n) => (
                    <Bar key={n} dataKey={n} fill={CHART_COLORS[n]} radius={[3, 3, 0, 0]} maxBarSize={22} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Your latest transactions</CardDescription>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity</p>
            ) : (
              <div className="divide-y divide-border">
                {recentActivity.map((activity) => (
                  <div key={activity.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground text-sm truncate">{activity.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(activity.timestamp).toLocaleDateString()} at {new Date(activity.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <p className={`font-semibold tabular-nums whitespace-nowrap ${activity.type === "credit" ? "text-success" : "text-destructive"}`}>
                      {activity.type === "credit" ? "+" : "-"}GHS {(activity.amount || 0).toFixed(2)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
