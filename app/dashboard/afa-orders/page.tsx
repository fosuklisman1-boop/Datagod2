"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Star, Clock, CheckCircle, AlertCircle, XCircle, Loader2, Plus } from "lucide-react"
import { AFASubmissionModal } from "@/components/afa-submission-modal"
import { toast } from "sonner"

interface AFAOrder {
  id: string
  order_code: string
  transaction_code?: string
  full_name?: string
  phone_number?: string
  gh_card_number?: string
  location?: string
  region?: string
  occupation?: string
  amount: number
  status: "pending" | "processing" | "completed" | "cancelled"
  created_at: string
}

interface Stats {
  total: number
  pending: number
  processing: number
  completed: number
  cancelled: number
}

export default function AFAOrdersPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [showSubmissionModal, setShowSubmissionModal] = useState(false)
  const [orders, setOrders] = useState<AFAOrder[]>([])
  const [stats, setStats] = useState<Stats>({ total: 0, pending: 0, processing: 0, completed: 0, cancelled: 0 })
  const [loading, setLoading] = useState(true)

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[AFA-ORDERS] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  // Fetch AFA orders
  useEffect(() => {
    if (user && !authLoading) {
      loadOrders()
    }
  }, [user, authLoading])

  const loadOrders = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        toast.error("Authentication required")
        return
      }

      const response = await fetch("/api/user/afa-orders", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (!response.ok) {
        throw new Error("Failed to fetch orders")
      }

      const data = await response.json()
      setOrders(data.orders || [])
      setStats(data.stats || { total: 0, pending: 0, processing: 0, completed: 0, cancelled: 0 })
    } catch (error) {
      console.error("[AFA-ORDERS] Error loading orders:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load AFA orders"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  if (authLoading || !user || loading) {
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
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">My AFA Orders</h1>
            <p className="text-gray-600 mt-1">Manage and track your MTN AFA registrations</p>
          </div>
          <Button
            onClick={() => setShowSubmissionModal(true)}
            className="bg-blue-600 hover:bg-blue-700"
            size="lg"
          >
            <Plus className="w-4 h-4 mr-2" />
            New Registration
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Orders</CardTitle>
              <Star className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
              <p className="text-xs text-gray-600">All time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-yellow-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.pending}</div>
              <p className="text-xs text-gray-600">Waiting</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Processing</CardTitle>
              <Clock className="h-4 w-4 text-orange-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.processing}</div>
              <p className="text-xs text-gray-600">In progress</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Delivered</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.completed}</div>
              <p className="text-xs text-gray-600">Completed</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Cancelled</CardTitle>
              <XCircle className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.cancelled}</div>
              <p className="text-xs text-gray-600">Cancelled</p>
            </CardContent>
          </Card>
        </div>

        {/* AFA Orders Table */}
        <Card>
          <CardHeader>
            <CardTitle>AFA Orders List</CardTitle>
            <CardDescription>Your MTN AFA registration orders</CardDescription>
          </CardHeader>
          <CardContent>
            {orders.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-gray-600 mb-4">No AFA orders yet</p>
                <Button
                  onClick={() => setShowSubmissionModal(true)}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Create Your First AFA Order
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Order Code</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Transaction Code</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Amount</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Beneficiary</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Phone</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {orders.map((order) => (
                      <tr key={order.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 text-sm font-semibold">{order.order_code}</td>
                        <td className="px-6 py-4 text-sm">{order.transaction_code || "-"}</td>
                        <td className="px-6 py-4 text-sm">
                          {new Date(order.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <Badge
                            className={
                              order.status === "completed"
                                ? "bg-green-100 text-green-800"
                                : order.status === "pending"
                                ? "bg-yellow-100 text-yellow-800"
                                : order.status === "processing"
                                ? "bg-blue-100 text-blue-800"
                                : "bg-red-100 text-red-800"
                            }
                          >
                            {order.status.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-sm">GHS {order.amount}</td>
                        <td className="px-6 py-4 text-sm">{order.full_name || "-"}</td>
                        <td className="px-6 py-4 text-sm">{order.phone_number || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {orders.length > 0 && (
              <div className="mt-4 flex justify-between items-center">
                <p className="text-sm text-gray-600">Showing {orders.length} of {stats.total} results</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* AFA Submission Modal */}
      <AFASubmissionModal
        isOpen={showSubmissionModal}
        onClose={() => setShowSubmissionModal(false)}
        userId={user.id}
        onSubmitSuccess={() => {
          // Reload orders after successful submission
          loadOrders()
          setShowSubmissionModal(false)
          toast.success("AFA order submitted successfully!")
        }}
      />
    </DashboardLayout>
  )
}
