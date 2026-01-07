"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { complaintService } from "@/lib/database"

interface Complaint {
  id: string
  user_id: string
  title: string
  description: string
  status: string
  priority: string
  order_id?: string
  order_details?: any
  evidence?: any
  resolution_notes?: string
  created_at: string
  updated_at: string
}

export default function ComplaintsPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [complaints, setComplaints] = useState<Complaint[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[COMPLAINTS] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  // Fetch complaints
  useEffect(() => {
    if (user && !authLoading) {
      loadComplaints()
    }
  }, [user, authLoading])

  const loadComplaints = async () => {
    try {
      setLoading(true)
      const data = await complaintService.getComplaints(user!.id)
      setComplaints(data || [])
    } catch (error) {
      console.error("Error loading complaints:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load complaints"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case "pending":
        return "bg-yellow-100 text-yellow-800"
      case "in_review":
        return "bg-blue-100 text-blue-800"
      case "resolved":
        return "bg-green-100 text-green-800"
      case "rejected":
        return "bg-red-100 text-red-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const getPriorityColor = (priority: string) => {
    switch (priority?.toLowerCase()) {
      case "high":
        return "text-red-600"
      case "medium":
        return "text-orange-600"
      case "low":
        return "text-green-600"
      default:
        return "text-gray-600"
    }
  }

  const filteredComplaints = complaints.filter(complaint =>
    complaint.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    complaint.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    complaint.id?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const stats = {
    total: complaints.length,
    pending: complaints.filter(c => c.status?.toLowerCase() === "pending").length,
    resolved: complaints.filter(c => c.status?.toLowerCase() === "resolved").length,
    rejected: complaints.filter(c => c.status?.toLowerCase() === "rejected").length,
  }

  if (authLoading || !user) {
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
        <div>
          <h1 className="text-3xl font-bold text-gray-900">My Complaints</h1>
          <p className="text-gray-600 mt-1">Track and manage your complaint submissions</p>
        </div>

        {/* Header Banner */}
        <Card className="bg-gradient-to-r from-orange-500 to-red-600 text-white border-0">
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <AlertCircle className="w-8 h-8 flex-shrink-0 mt-1" />
              <div>
                <h2 className="text-xl font-bold">My Complaints</h2>
                <p className="text-orange-100 mt-1">
                  Track and manage your complaint submissions
                </p>
                <p className="text-orange-100 mt-2">
                  Monitor the status of your complaints and view responses from our support team.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Cards */}
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Complaints</CardTitle>
              <AlertCircle className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
              <p className="text-xs text-gray-600">All time</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <AlertCircle className="h-4 w-4 text-yellow-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.pending}</div>
              <p className="text-xs text-gray-600">Awaiting review</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Resolved</CardTitle>
              <AlertCircle className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.resolved}</div>
              <p className="text-xs text-gray-600">Completed</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Rejected</CardTitle>
              <AlertCircle className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.rejected}</div>
              <p className="text-xs text-gray-600">Not approved</p>
            </CardContent>
          </Card>
        </div>

        {/* Complaints Table */}
        <Card>
          <CardHeader>
            <CardTitle>Complaints List</CardTitle>
            <CardDescription>Your complaint submissions and responses</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Search */}
            <div className="flex flex-wrap gap-2 pb-4 border-b">
              <div className="ml-auto">
                <input
                  type="text"
                  placeholder="Search complaints..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            </div>

            {/* Loading State */}
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
              </div>
            ) : filteredComplaints.length === 0 ? (
              <div className="text-center py-8">
                <AlertCircle className="w-12 h-12 text-gray-300 mx-auto mb-2" />
                <p className="text-gray-500">No complaints found</p>
              </div>
            ) : (
              /* Table */
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Ticket ID</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Title</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Priority</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                      <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredComplaints.map((complaint) => (
                      <tr key={complaint.id} className="border-b hover:bg-gray-50">
                        <td className="px-6 py-3 text-sm text-gray-900 font-mono">{complaint.id.slice(0, 8)}</td>
                        <td className="px-6 py-3 text-sm text-gray-900">{complaint.title}</td>
                        <td className="px-6 py-3 text-sm">
                          <span className={`font-medium ${getPriorityColor(complaint.priority)}`}>
                            {complaint.priority}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-sm">
                          <Badge className={getStatusColor(complaint.status)}>
                            {complaint.status}
                          </Badge>
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-600">
                          {new Date(complaint.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Summary */}
            {!loading && filteredComplaints.length > 0 && (
              <div className="flex justify-between items-center pt-4">
                <p className="text-sm text-gray-600">Showing {filteredComplaints.length} of {complaints.length} complaints</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Submit Complaint Button */}
        <div className="flex justify-center">
          <Button 
            onClick={() => router.push("/dashboard/my-orders")}
            className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 px-8"
          >
            Submit New Complaint
          </Button>
        </div>
      </div>
    </DashboardLayout>
  )
}
