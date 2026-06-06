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
import { TrendingUp, ShoppingCart, CheckCircle, AlertCircle, Clock, Loader2, type LucideIcon } from "lucide-react"
import { BulkOrdersForm } from "@/components/bulk-orders-form"
import { supabase } from "@/lib/supabase"

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
        {/* Greeting */}
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
              {getGreeting()}, {firstName}! {getGreetingEmoji()}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} • {new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}
            </p>
          </div>
          <Button onClick={() => router.push("/dashboard/data-packages")} className="font-semibold">
            + Buy Data
          </Button>
        </div>

        {/* Wallet hero + account meta */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Card
            data-tour="wallet-balance"
            className={`lg:col-span-2 border-0 text-white relative overflow-hidden ${isDealer
              ? "bg-gradient-to-br from-[#37146b] to-[#7c1bd6]"
              : "bg-gradient-to-br from-primary to-violet-600"
              }`}
          >
            <div className="absolute -right-10 -top-12 w-48 h-48 rounded-full bg-white/10" />
            <CardContent className="p-6 relative">
              <p className="text-sm font-medium text-white/85">Wallet Balance</p>
              <p className="text-4xl font-extrabold tracking-tight tabular-nums mt-2">
                GHS {Math.max(0, walletBalance || 0).toFixed(2)}
              </p>
              <p className="text-xs text-white/75 mt-1">Available funds</p>
              <div className="flex flex-wrap gap-2 mt-5">
                <Button onClick={() => router.push("/dashboard/wallet")} className="bg-white text-violet-700 hover:bg-white/90 font-semibold">
                  ＋ Top Up
                </Button>
                <Button onClick={() => router.push("/dashboard/data-packages")} className="bg-white/15 text-white hover:bg-white/25 border-0">
                  Buy Data
                </Button>
                <Button onClick={() => router.push("/dashboard/my-orders")} className="bg-white/15 text-white hover:bg-white/25 border-0">
                  My Orders
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Role</span>
                <span className="text-sm font-semibold text-foreground">{isDealer ? "Authorized Dealer" : "Premium Agent"}</span>
              </div>
              <div className="h-px bg-border" />
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Status</span>
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-success">
                  <span className="w-2 h-2 rounded-full bg-success" />Active
                </span>
              </div>
              <div className="h-px bg-border" />
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Member Since</span>
                <span className="text-sm font-semibold text-foreground">{joinDate || "Recently"}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Total Orders" value={formatCount(stats.totalOrders)} hint="All time" tone="primary" icon={ShoppingCart} />
          <StatCard label="Completed" value={formatCount(stats.completed)} hint={`${stats.successRate} success rate`} tone="success" icon={CheckCircle} />
          <StatCard label="Processing" value={formatCount(stats.processing)} hint="In progress" tone="warning" icon={TrendingUp} />
          <StatCard label="Pending" value={formatCount(stats.pending)} hint="Awaiting processing" tone="warning" icon={Clock} />
          <StatCard label="Failed" value={formatCount(stats.failed)} hint="Refunded if charged" tone="danger" icon={AlertCircle} />
        </div>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Quick Actions</CardTitle>
            <CardDescription>Get started with common tasks</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Button onClick={() => router.push("/dashboard/data-packages")} className="font-semibold">
              Buy Data Package
            </Button>
            <Button variant="outline" onClick={() => router.push("/dashboard/airtime")} className="font-semibold">
              Buy Airtime
            </Button>
            <Button variant="outline" onClick={() => router.push("/dashboard/my-shop")} className="font-semibold">
              Create Shop
            </Button>
            <Button variant="outline" onClick={() => router.push("/dashboard/my-orders")} className="font-semibold">
              View My Orders
            </Button>
            <Button variant="outline" onClick={() => router.push("/dashboard/wallet")} className="font-semibold">
              Top Up Wallet
            </Button>
          </CardContent>
        </Card>

        {/* Bulk Orders Section */}
        <BulkOrdersForm />

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
