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
import { TrendingUp, ShoppingCart, CheckCircle, AlertCircle, Moon, Clock, Loader2, Wallet } from "lucide-react"
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
            if (extProfile && profile?.phone_number && !extProfile.phone_verified) {
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
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  // Redirect happens in useEffect, but render nothing while waiting
  if (!user) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin" />
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
      <div className="space-y-6">
        {/* Greeting Card */}
        <Card className={`border-0 hover:shadow-2xl transition-all duration-300 text-white ${isDealer
          ? "bg-gradient-to-r from-amber-500 via-orange-500 to-yellow-500"
          : "bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600"
          }`}>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-3xl font-bold mb-1">{getGreeting()}, {firstName}! {getGreetingEmoji()}</h2>
                <p className={isDealer ? "text-amber-100" : "text-indigo-100"}>
                  {new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} • {new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}
                </p>
              </div>
              <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center backdrop-blur border border-white/30">
                <TrendingUp className="h-8 w-8 text-white" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
              <div className="bg-white/10 backdrop-blur rounded-lg p-3 border border-white/20">
                <p className={`${isDealer ? "text-amber-100" : "text-indigo-100"} text-xs font-medium`}>Role</p>
                <p className="text-white font-semibold mt-1">{isDealer ? "Authorized Dealer" : "Premium Agent"}</p>
              </div>
              <div className="bg-white/10 backdrop-blur rounded-lg p-3 border border-white/20">
                <p className={`${isDealer ? "text-amber-100" : "text-indigo-100"} text-xs font-medium`}>Status</p>
                <p className="text-white font-semibold mt-1">Active</p>
              </div>
              <div className="bg-white/10 backdrop-blur rounded-lg p-3 border border-white/20">
                <p className={`${isDealer ? "text-amber-100" : "text-indigo-100"} text-xs font-medium`}>Member Since</p>
                <p className="text-white font-semibold mt-1">{joinDate || "Recently"}</p>
              </div>
            </div>

            <p className={`${isDealer ? "text-amber-100" : "text-indigo-100"} mt-4`}>Here's what's happening with your data packages today.</p>
          </CardContent>
        </Card>

        {/* Page Header */}
        <div>
          <h1 className={`text-2xl sm:text-3xl md:text-4xl font-bold bg-clip-text text-transparent ${isDealer
            ? "bg-gradient-to-r from-amber-600 via-orange-600 to-yellow-600"
            : "bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600"
            }`}>
            Dashboard
          </h1>
          <p className="text-gray-500 mt-1 font-medium">Welcome back! Here's your account overview.</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 sm:gap-4">
          {/* Total Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-cyan-500 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40 hover:border-cyan-300/60">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Total Orders</CardTitle>
              <div className="bg-gradient-to-br from-cyan-400/30 to-blue-400/20 backdrop-blur p-2 rounded-lg border border-cyan-300/60 shadow-lg">
                <ShoppingCart className="h-4 w-4 text-cyan-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">{formatCount(stats.totalOrders)}</div>
              <p className="text-xs text-gray-500">All time orders</p>
            </CardContent>
          </Card>

          {/* Completed Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-emerald-500 bg-gradient-to-br from-emerald-50/60 to-teal-50/40 backdrop-blur-xl border border-emerald-200/40 hover:border-emerald-300/60">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Completed</CardTitle>
              <div className="bg-gradient-to-br from-emerald-400/30 to-teal-400/20 backdrop-blur p-2 rounded-lg border border-emerald-300/60 shadow-lg">
                <CheckCircle className="h-4 w-4 text-emerald-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">{formatCount(stats.completed)}</div>
              <p className="text-xs text-gray-500">{stats.successRate} success rate</p>
            </CardContent>
          </Card>

          {/* Processing Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-amber-500 bg-gradient-to-br from-amber-50/60 to-orange-50/40 backdrop-blur-xl border border-amber-200/40 hover:border-amber-300/60">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Processing</CardTitle>
              <div className="bg-gradient-to-br from-amber-400/30 to-orange-400/20 backdrop-blur p-2 rounded-lg border border-amber-300/60 shadow-lg">
                <TrendingUp className="h-4 w-4 text-amber-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-transparent">{formatCount(stats.processing)}</div>
              <p className="text-xs text-gray-500">In progress</p>
            </CardContent>
          </Card>

          {/* Failed Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-rose-500 bg-gradient-to-br from-rose-50/60 to-pink-50/40 backdrop-blur-xl border border-rose-200/40 hover:border-rose-300/60">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Failed</CardTitle>
              <div className="bg-gradient-to-br from-rose-400/30 to-pink-400/20 backdrop-blur p-2 rounded-lg border border-rose-300/60 shadow-lg">
                <AlertCircle className="h-4 w-4 text-rose-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-rose-600 to-pink-600 bg-clip-text text-transparent">{formatCount(stats.failed)}</div>
              <p className="text-xs text-gray-500">No failures</p>
            </CardContent>
          </Card>

          {/* Pending Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-indigo-500 bg-gradient-to-br from-indigo-50/60 to-purple-50/40 backdrop-blur-xl border border-indigo-200/40 hover:border-indigo-300/60">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Pending</CardTitle>
              <div className="bg-gradient-to-br from-indigo-400/30 to-purple-400/20 backdrop-blur p-2 rounded-lg border border-indigo-300/60 shadow-lg">
                <Clock className="h-4 w-4 text-indigo-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">{formatCount(stats.pending)}</div>
              <p className="text-xs text-gray-500">Awaiting processing</p>
            </CardContent>
          </Card>

          {/* Wallet Balance */}
          <Card
            className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-green-500 bg-gradient-to-br from-green-50/60 to-emerald-50/40 backdrop-blur-xl border border-green-200/40 hover:border-green-300/60"
            data-tour="wallet-balance"
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Wallet Balance</CardTitle>
              <div className="bg-gradient-to-br from-green-400/30 to-emerald-400/20 backdrop-blur p-2 rounded-lg border border-green-300/60 shadow-lg">
                <Wallet className="h-4 w-4 text-green-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent">
                GHS {Math.max(0, walletBalance || 0).toFixed(2)}
              </div>
              <p className="text-xs text-gray-500">Available funds</p>
            </CardContent>
          </Card>
        </div>

        {/* Quick Actions */}
        <Card className="bg-gradient-to-br from-violet-50/60 to-purple-50/40 backdrop-blur-xl hover:shadow-2xl transition-all duration-300 border border-violet-200/40 hover:border-violet-300/60">
          <CardHeader>
            <CardTitle className="text-gray-900">Quick Actions</CardTitle>
            <CardDescription>Get started with common tasks</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <Button
              onClick={() => router.push("/dashboard/my-shop")}
              className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 font-semibold text-white"
            >
              Create Shop
            </Button>
            <Button
              onClick={() => router.push("/dashboard/data-packages")}
              className="bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 hover:from-violet-700 hover:via-purple-700 hover:to-fuchsia-700 shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 font-semibold text-white"
            >
              Buy Data Package
            </Button>
            <Button
              onClick={() => router.push("/dashboard/airtime")}
              className="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 font-semibold text-white"
            >
              Buy Airtime
            </Button>
            <Button
              variant="outline"
              onClick={() => router.push("/dashboard/my-orders")}
              className="hover:bg-cyan-50/80 hover:backdrop-blur hover:border-cyan-400 hover:text-cyan-700 transition-all duration-300 hover:shadow-md font-semibold bg-cyan-50/30 backdrop-blur border-cyan-300/40 text-cyan-700"
            >
              View My Orders
            </Button>
            <Button
              variant="outline"
              onClick={() => router.push("/dashboard/wallet")}
              className="hover:bg-emerald-50/80 hover:backdrop-blur hover:border-emerald-400 hover:text-emerald-700 transition-all duration-300 hover:shadow-md font-semibold bg-emerald-50/30 backdrop-blur border-emerald-300/40 text-emerald-700"
            >
              Top Up Wallet
            </Button>
          </CardContent>
        </Card>

        {/* Bulk Orders Section */}
        <BulkOrdersForm />

        {/* Recent Activity */}
        <Card className="hover:shadow-2xl transition-all duration-300 bg-gradient-to-br from-indigo-50/60 to-blue-50/40 backdrop-blur-xl border border-indigo-200/40 hover:border-indigo-300/60">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Your latest transactions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {recentActivity.length === 0 ? (
                <p className="text-sm text-gray-500">No recent activity</p>
              ) : (
                recentActivity.map((activity) => (
                  <div key={activity.id} className="flex items-center justify-between pb-4 border-b hover:bg-white/40 backdrop-blur -mx-4 px-4 py-2 rounded transition-colors duration-200">
                    <div>
                      <p className="font-medium">{activity.description}</p>
                      <p className="text-sm text-gray-600">{new Date(activity.timestamp).toLocaleDateString()} at {new Date(activity.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                    <p className={`font-semibold ${activity.type === "credit" ? "text-green-600" : "text-red-600"}`}>
                      {activity.type === "credit" ? "+" : "-"}GHS {(activity.amount || 0).toFixed(2)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
