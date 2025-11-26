"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { TrendingUp, ShoppingCart, CheckCircle, AlertCircle, Moon } from "lucide-react"
import { BulkOrdersForm } from "@/components/bulk-orders-form"
import { supabase } from "@/lib/supabase"

export default function DashboardPage() {
  const router = useRouter()
  const [firstName, setFirstName] = useState("")
  const [userEmail, setUserEmail] = useState("")
  const [joinDate, setJoinDate] = useState("")

  useEffect(() => {
    fetchUserInfo()
  }, [])

  const fetchUserInfo = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user?.email) {
        setUserEmail(user.email)
        // Extract first name from email (part before @)
        const name = user.email.split("@")[0]
        setFirstName(name.charAt(0).toUpperCase() + name.slice(1))

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
  return (
    <DashboardLayout>
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Total Orders */}
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-cyan-500 bg-gradient-to-br from-cyan-50/60 to-blue-50/40 backdrop-blur-xl border border-cyan-200/40 hover:border-cyan-300/60">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-gray-900">Total Orders</CardTitle>
              <div className="bg-gradient-to-br from-cyan-400/30 to-blue-400/20 backdrop-blur p-2 rounded-lg border border-cyan-300/60 shadow-lg">
                <ShoppingCart className="h-4 w-4 text-cyan-600" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gradient-to-r from-cyan-600 to-blue-600 bg-clip-text text-transparent">5,002</div>
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
              <div className="text-2xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">4,951</div>
              <p className="text-xs text-gray-500">99% success rate</p>
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
              <div className="text-2xl font-bold bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-transparent">46</div>
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
              <div className="text-2xl font-bold bg-gradient-to-r from-rose-600 to-pink-600 bg-clip-text text-transparent">0</div>
              <p className="text-xs text-gray-500">No failures</p>
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
              <div className="flex items-center justify-between pb-4 border-b hover:bg-white/40 backdrop-blur -mx-4 px-4 py-2 rounded transition-colors duration-200">
                <div>
                  <p className="font-medium">Wallet Top Up</p>
                  <p className="text-sm text-gray-600">Today at 2:30 PM</p>
                </div>
                <p className="font-semibold text-green-600">+GHS 1,000.00</p>
              </div>
              <div className="flex items-center justify-between pb-4 border-b hover:bg-white/40 backdrop-blur -mx-4 px-4 py-2 rounded transition-colors duration-200">
                <div>
                  <p className="font-medium">Data Purchase - MTN 5GB</p>
                  <p className="text-sm text-gray-600">Yesterday at 10:15 AM</p>
                </div>
                <p className="font-semibold text-red-600">-GHS 19.50</p>
              </div>
              <div className="flex items-center justify-between hover:bg-white/40 backdrop-blur -mx-4 px-4 py-2 rounded transition-colors duration-200">
                <div>
                  <p className="font-medium">Data Purchase - TELECEL 10GB</p>
                  <p className="text-sm text-gray-600">2 days ago</p>
                </div>
                <p className="font-semibold text-red-600">-GHS 45.00</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
