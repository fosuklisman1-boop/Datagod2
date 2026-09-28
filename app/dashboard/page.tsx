"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { useAuth } from "@/hooks/use-auth"
import { useOnboarding } from "@/hooks/use-onboarding"
import { useUserRole } from "@/hooks/use-user-role"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { WalletOnboardingModal } from "@/components/onboarding/wallet-onboarding-modal"
import { PhoneVerifyModal } from "@/components/phone-verify-modal"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  TrendingUp, ShoppingCart, CheckCircle, AlertCircle, Clock, Loader2,
  Store, Users, Send, IdCard, Wallet as WalletIcon, Smartphone,
  type LucideIcon,
} from "lucide-react"
import { supabase } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { getServicePrimaryPath, type DomainService } from "@/lib/custom-domains"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { LatestOrderCard } from "@/components/dashboard/latest-order-card"
import { NetworkHealthCard, NETWORK_BADGE } from "@/components/dashboard/network-health-card"
// Type-only: order-health-service.ts pulls in mtn-hold.ts -> sms-service.ts
// -> push-service.ts -> web-push (raw Node net/tls sockets) at runtime. A
// value import (e.g. its HEALTH_NETWORKS const) would drag that whole chain
// into this client bundle and fail the build ("Module not found: Can't
// resolve 'net'"), so the network list below is instead derived from
// NETWORK_BADGE's keys, which lives in the client-safe network-health-card.
import type { LatestOrderSummary, NetworkHealthStat, HealthNetwork } from "@/lib/order-health-service"
import { networkBadgeClasses } from "@/lib/network-status-theme"

// Short, quick-action-appropriate labels for each service, used when a custom
// domain is scoped to one or more services and the primary CTAs are repointed
// to the domain's own first selected service instead of the hardcoded
// data-packages target.
const SERVICE_QUICK_LABELS: Record<DomainService, string> = {
  data_bundles: "Buy Data",
  airtime: "Buy Airtime",
  results_checker: "Check Results",
  bulk_sms: "Buy SMS",
}

// Real Datagod services (not Apex Prime's Academic Writing / Apple Music /
// Merchant SIM tiles, which don't apply to this platform).
const PROMO_SERVICES: { title: string; description: string; href: string; icon: LucideIcon }[] = [
  { title: "Own Shop", description: "Launch your white-label storefront", href: "/dashboard/my-shop", icon: Store },
  { title: "USSD / WhatsApp Bot", description: "Sell through your own bot", href: "/dashboard/ussd-shop", icon: Smartphone },
  { title: "Sub-Agents", description: "Recruit sellers, earn on every sale", href: "/dashboard/sub-agents", icon: Users },
  { title: "Bulk SMS", description: "Send SMS campaigns at scale", href: "/dashboard/sms", icon: Send },
  { title: "AFA Registration", description: "Register and manage AFA orders", href: "/dashboard/afa-orders", icon: IdCard },
  { title: "Wallet Top Up", description: "Fund your wallet instantly", href: "/dashboard/wallet", icon: WalletIcon },
]

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

function BannerStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-white/10 p-3 text-center">
      <p className="text-lg font-extrabold text-white tabular-nums">{value}</p>
      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70">{label}</p>
    </div>
  )
}

// Clean Fintech stat card: neutral surface, one accent chip, flat number.
const STAT_TONES: Record<string, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/10 text-destructive",
}
function StatCard({
  label, value, hint, tone = "primary", icon: Icon, ...rest
}: {
  label: string
  value: string
  hint?: string
  tone?: keyof typeof STAT_TONES
  icon: LucideIcon
} & React.ComponentProps<typeof Card>) {
  return (
    <Card className="transition-shadow hover:shadow-md" {...rest}>
      <CardContent className="p-4 sm:p-5">
        <div className={`w-9 h-9 rounded-xl grid place-items-center ${STAT_TONES[tone]}`}>
          <Icon className="h-4 w-4" />
        </div>
        <p className="text-xs font-medium text-muted-foreground mt-3">{label}</p>
        <p className="text-2xl font-bold tracking-tight tabular-nums mt-0.5 text-foreground">{value}</p>
        {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
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
  const [walletBalance, setWalletBalance] = useState(0)
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

        // Wallet balance
        token
          ? fetch("/api/wallet/balance", { headers: { Authorization: `Bearer ${token}` } })
              .then(r => r.json())
              .then(d => setWalletBalance(d.balance ?? 0))
              .catch(() => setWalletBalance(0))
          : Promise.resolve(),

        // Latest completed order (real order-history trust widget)
        token
          ? fetchLatestOrder(token)
          : Promise.resolve(setLatestOrderLoading(false)),

        // Platform-wide network health (real, computed from order history)
        token
          ? fetchNetworkHealth(token)
          : Promise.resolve(setNetworkHealthLoading(false)),
      ])
    } catch {
      // silent — individual settled results handle their own errors
    }
  }

  const getGreeting = () => {
    const hour = new Date().getHours()
    if (hour < 12) return "Good Morning"
    if (hour < 18) return "Good Afternoon"
    return "Good Night"
  }

  const getGreetingEmoji = () => {
    const hour = new Date().getHours()
    if (hour < 12) return "☀️"
    if (hour < 18) return "👋"
    return "🌙"
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
        {/* Greeting hero: banner + 3 real stat tiles.
            Reference shows Orders Placed/Amount Spent/Data Dispatched — this
            platform doesn't track per-user spend or data dispatched, so those
            are substituted with Orders Placed / Wallet Balance / Success Rate,
            all backed by real /api/dashboard/stats + /api/wallet/balance data. */}
        <PageHeaderBanner
          title={`${getGreeting()}, ${firstName}! ${getGreetingEmoji()}`}
          subtitle={new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        >
          <div className="grid grid-cols-3 gap-3">
            <BannerStat value={formatCount(stats.totalOrders)} label="Orders Placed" />
            <BannerStat value={`GHS ${Math.max(0, walletBalance || 0).toFixed(2)}`} label="Wallet Balance" />
            <BannerStat value={stats.successRate} label="Success Rate" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => router.push("/dashboard/wallet")} className="bg-white text-primary hover:bg-white/90 font-semibold">
              ＋ Top Up
            </Button>
            <Button onClick={() => router.push(primaryService ? getServicePrimaryPath(primaryService) : "/dashboard/data-packages")} className="bg-white/15 text-white hover:bg-white/25 border-0">
              {primaryService ? SERVICE_QUICK_LABELS[primaryService] : "Buy Data"}
            </Button>
            <Button onClick={() => router.push("/dashboard/my-orders")} className="bg-white/15 text-white hover:bg-white/25 border-0">
              My Orders
            </Button>
          </div>
        </PageHeaderBanner>

        {/* Account meta */}
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Role</p>
              <p className="text-sm font-semibold text-foreground">{isDealer ? "Authorized Dealer" : "Premium Agent"}</p>
            </div>
            <div className="h-8 w-px bg-border" />
            <div>
              <p className="text-xs font-medium text-muted-foreground">Status</p>
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-success">
                <span className="w-2 h-2 rounded-full bg-success" />Active
              </span>
            </div>
            <div className="h-8 w-px bg-border" />
            <div>
              <p className="text-xs font-medium text-muted-foreground">Member Since</p>
              <p className="text-sm font-semibold text-foreground">{joinDate || "Recently"}</p>
            </div>
          </CardContent>
        </Card>

        {/* Network quick shortcuts — network + name only, no fabricated
            per-network order volumes. Uses the same badge styling as the
            Network Health section below for visual consistency. */}
        <div>
          <p className="mb-2 text-sm font-semibold text-foreground">Order by Network</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(Object.keys(NETWORK_BADGE) as HealthNetwork[]).map((net) => {
              const badge = NETWORK_BADGE[net]
              return (
                <button
                  key={net}
                  onClick={() => router.push(primaryService ? getServicePrimaryPath(primaryService) : "/dashboard/data-packages")}
                  className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-card p-4 text-center transition hover:border-primary/40 hover:shadow-sm"
                >
                  <span className={cn("flex h-10 w-10 items-center justify-center rounded-full text-xs font-extrabold", networkBadgeClasses(badge.network))}>
                    {badge.badgeText}
                  </span>
                  <span className="text-xs font-semibold text-foreground">{net}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Promo carousel — Datagod's real services, not Apex Prime's
            irrelevant tiles (Academic Writing, Apple Music/iCloud, Merchant
            SIM Onboarding). */}
        <div>
          <p className="mb-2 text-sm font-semibold text-foreground">Grow With Datagod</p>
          <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1 snap-x scrollbar-thin">
            {PROMO_SERVICES.map((svc) => (
              <button
                key={svc.title}
                onClick={() => router.push(svc.href)}
                className="flex min-w-[230px] shrink-0 snap-start items-start gap-3 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:shadow-sm"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <svc.icon className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{svc.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{svc.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Latest completed order: real, computed trust widget — no fabricated numbers */}
        <LatestOrderCard
          order={latestOrder}
          loading={latestOrderLoading}
          onRefresh={() => refreshWithFreshToken(fetchLatestOrder)}
        />

        {/* Order status — Pending/Processing/Completed/Failed (Total Orders and
            Success Rate already surfaced in the banner above). */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Pending" value={formatCount(stats.pending)} hint="Awaiting processing" tone="warning" icon={Clock} />
          <StatCard label="Processing" value={formatCount(stats.processing)} hint="In progress" tone="warning" icon={TrendingUp} />
          <StatCard label="Completed" value={formatCount(stats.completed)} hint={`${stats.successRate} success rate`} tone="success" icon={CheckCircle} />
          <StatCard label="Failed" value={formatCount(stats.failed)} hint="Refunded if charged" tone="danger" icon={AlertCircle} />
        </div>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Quick Actions</CardTitle>
            <CardDescription>Get started with common tasks</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {(!domainBranding.services || domainBranding.services.includes("data_bundles")) && (
              <Button onClick={() => router.push("/dashboard/data-packages")} className="font-semibold">
                Buy Data Package
              </Button>
            )}
            {(!domainBranding.services || domainBranding.services.includes("airtime")) && (
              <Button variant="outline" onClick={() => router.push("/dashboard/airtime")} className="font-semibold">
                Buy Airtime
              </Button>
            )}
            {domainBranding.services?.includes("results_checker") && (
              <Button variant="outline" onClick={() => router.push("/dashboard/results-checker")} className="font-semibold">
                Check Results
              </Button>
            )}
            {domainBranding.services?.includes("bulk_sms") && (
              <Button variant="outline" onClick={() => router.push("/dashboard/sms")} className="font-semibold">
                Buy SMS
              </Button>
            )}
            {!domainBranding.services && (
              <Button variant="outline" onClick={() => router.push("/dashboard/my-shop")} className="font-semibold">
                Create Shop
              </Button>
            )}
            {(!domainBranding.services || domainBranding.services.includes("data_bundles")) && (
              <Button variant="outline" onClick={() => router.push("/dashboard/bulk-orders")} className="font-semibold">
                Bulk Order
              </Button>
            )}
            <Button variant="outline" onClick={() => router.push("/dashboard/my-orders")} className="font-semibold">
              View My Orders
            </Button>
            <Button variant="outline" onClick={() => router.push("/dashboard/wallet")} className="font-semibold">
              Top Up Wallet
            </Button>
          </CardContent>
        </Card>

        {/* Network health: real, computed — no fabricated numbers */}
        <NetworkHealthCard
          networks={networkHealth}
          loading={networkHealthLoading}
          onRefresh={() => refreshWithFreshToken(fetchNetworkHealth)}
        />

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
