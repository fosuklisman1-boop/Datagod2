"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { useAuth } from "@/hooks/use-auth"
import { useOnboarding } from "@/hooks/use-onboarding"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { WalletOnboardingModal } from "@/components/onboarding/wallet-onboarding-modal"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { TrendingUp, ShoppingCart, CheckCircle, AlertCircle, Moon, Clock, Loader2, Wallet } from "lucide-react"
import { BulkOrdersForm } from "@/components/bulk-orders-form"
import { supabase } from "@/lib/supabase"

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
  const [firstName, setFirstName] = useState("")
  const [userEmail, setUserEmail] = useState("")
  const [joinDate, setJoinDate] = useState("")
  const [walletBalance, setWalletBalance] = useState(0)
  const [stats, setStats] = useState<DashboardStats>({
    totalOrders: 0,
    completed: 0,
    processing: 0,
    failed: 0,
    pending: 0,
    successRate: "0%"
  })
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([])

  // Auth protection - redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[DASHBOARD] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      fetchUserInfo()
      fetchDashboardStats()
      fetchRecentActivity()
      fetchWalletBalance()
    }
  }, [user])

  const fetchUserInfo = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user?.id) {
        setUserEmail(user.email || "")
        
        // Fetch user profile from users table
        const { data: userProfile, error } = await supabase
          .from("users")
          .select("first_name, last_name")
          .eq("id", user.id)
          .single()

        if (!error && userProfile) {
          // Use last_name if available, otherwise use first_name, otherwise use email prefix
          const name = userProfile.last_name || userProfile.first_name || user.email?.split("@")[0] || "User"
          setFirstName(name.charAt(0).toUpperCase() + name.slice(1))
        } else {
          // Fallback to email prefix if profile not found
          const name = user.email?.split("@")[0] || "User"
          setFirstName(name.charAt(0).toUpperCase() + name.slice(1))
        }

        // Get user's creation date
        const createdAt = user.created_at
        if (createdAt) {
          const date = new Date(createdAt)
          const now = new Date()
          const diffTime = Math.abs(now.getTime() - date.getTime())
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
          
          if (diffDays < 1) {
            setJoinDate("Today")
          } else if (diffDays < 7) {
            setJoinDate(`${diffDays} days ago`)
          } else if (diffDays < 30) {
            const weeks = Math.floor(diffDays / 7)
            setJoinDate(`${weeks} week${weeks > 1 ? "s" : ""} ago`)
          } else if (diffDays < 365) {
            const months = Math.floor(diffDays / 30)
            setJoinDate(`${months} month${months > 1 ? "s" : ""} ago`)
          } else {
            const years = Math.floor(diffDays / 365)
            setJoinDate(`${years} year${years > 1 ? "s" : ""} ago`)
          }
        }
      }
    } catch (error) {
      console.error("Error fetching user info:", error)
    }
  }

  const fetchDashboardStats = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        console.error("No auth session")
        return
      }

      const response = await fetch("/api/dashboard/stats", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })
      if (!response.ok) {
        throw new Error("Failed to fetch stats")
      }
      const result = await response.json()
      if (result.success) {
        setStats(result.stats)
        console.log("Dashboard stats loaded:", result.stats)
      }
    } catch (error) {
      console.error("Error fetching dashboard stats:", error)
    }
  }

  const fetchRecentActivity = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const response = await fetch("/api/transactions/list?limit=3", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })
      if (response.ok) {
        const data = await response.json()
        const activities = (data.transactions || []).map((txn: any) => ({
          id: txn.id,
          description: txn.description,
          amount: txn.amount,
          type: txn.type,
          timestamp: txn.created_at,
        }))
        setRecentActivity(activities)
      }
    } catch (error) {
      console.error("Error fetching recent activity:", error)
    }
  }

  const fetchWalletBalance = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        console.error("No auth session")
        return
      }

      const response = await fetch("/api/wallet/balance", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })
      const data = await response.json()
      setWalletBalance(data.balance || 0)
    } catch (error) {
      console.error("Error fetching wallet balance:", error)
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

  // Show loading state while checking authentication
  if (authLoading) {
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
      <div className="space-y-6">
        {/* Greeting Card */}
        <Card className="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 border-0 hover:shadow-2xl transition-all duration-300 text-white">
          <CardContent className="pt-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-3xl font-bold mb-1">{getGreeting()}, {firstName}! {getGreetingEmoji()}</h2>
                <p className="text-indigo-100">{new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} • {new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}</p>
              </div>
              <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center backdrop-blur border border-white/30">
                <TrendingUp className="w-8 h-8 text-white" />
              </div>
            </div>
            
            <div className="grid grid-cols-3 gap-4 mt-6">
              <div className="bg-white/10 backdrop-blur rounded-lg p-3 border border-white/20">
                <p className="text-indigo-100 text-xs font-medium">Role</p>
                <p className="text-white font-semibold mt-1">Premium Agent</p>
              </div>
              <div className="bg-white/10 backdrop-blur rounded-lg p-3 border border-white/20">
                <p className="text-indigo-100 text-xs font-medium">Status</p>
                <p className="text-white font-semibold mt-1">Active</p>
              </div>
              <div className="bg-white/10 backdrop-blur rounded-lg p-3 border border-white/20">
                <p className="text-indigo-100 text-xs font-medium">Member Since</p>
                <p className="text-white font-semibold mt-1">{joinDate || "Recently"}</p>
              </div>
            </div>

            <p className="text-indigo-100 mt-4">Here's what's happening with your data packages today.</p>
          </CardContent>
        </Card>

        {/* Page Header */}
        <div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 bg-clip-text text-transparent">Dashboard</h1>
          <p className="text-gray-500 mt-1 font-medium">Welcome back! Here's your account overview.</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-3 md:grid-cols-5 gap-2 sm:gap-4">
          {/* Total Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-cyan-500 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40 hover:border-cyan-300/60">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Total Orders</CardTitle>
              <div className="bg-gradient-to-br from-cyan-400/30 to-blue-400/20 backdrop-blur p-2 rounded-lg border border-cyan-300/60 shadow-lg">
                <ShoppingCart className="h-4 w-4 text-cyan-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">{stats.totalOrders.toLocaleString()}</div>
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
              <div className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">{stats.completed.toLocaleString()}</div>
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
              <div className="text-2xl font-bold bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-transparent">{stats.processing}</div>
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
              <div className="text-2xl font-bold bg-gradient-to-r from-rose-600 to-pink-600 bg-clip-text text-transparent">{stats.failed}</div>
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
              <div className="text-2xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">{stats.pending}</div>
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
                GHS {walletBalance.toFixed(2)}
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
          <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
                      {activity.type === "credit" ? "+" : "-"}GHS {activity.amount.toFixed(2)}
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
