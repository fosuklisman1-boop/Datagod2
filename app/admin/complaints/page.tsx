"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useAdminProtected } from "@/hooks/use-admin"
import { complaintService } from "@/lib/database"
import { notificationTemplates } from "@/lib/notification-service"
import { AlertCircle, CheckCircle, Clock, X, Eye, MessageSquare, Loader2, Filter } from "lucide-react"
import { toast } from "sonner"

interface Complaint {
  id: string
  user_id: string
  title: string
  description: string
  status: string
  priority: string
  resolution_notes?: string
  created_at: string
  updated_at: string
  order_id?: string
  order_details?: {
    phone?: string
    phoneNumber?: string
    package?: string
    packageName?: string
    network?: string
    amount?: number
    date?: string
  }
  evidence?: {
    balance_image_url?: string
    momo_receipt_url?: string
    balance_image_path?: string
    momo_receipt_path?: string
  }
  user?: {
    email: string
    id: string
  }
}

export default function AdminComplaintsPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [complaints, setComplaints] = useState<Complaint[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedComplaint, setSelectedComplaint] = useState<Complaint | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [statusFilter, setStatusFilter] = useState("all")
  const [priorityFilter, setPriorityFilter] = useState("all")
  const [resolutionNotes, setResolutionNotes] = useState("")
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState("")
  const [evidenceUrls, setEvidenceUrls] = useState<{
    balance_image_url?: string
    momo_receipt_url?: string
  }>({})

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadComplaints()
    }
  }, [isAdmin, adminLoading])

  // Regenerate evidence URLs when modal opens
  useEffect(() => {
    const regenerateEvidenceUrls = async () => {
      if (!selectedComplaint?.evidence) return

      try {
        const response = await fetch("/api/admin/complaints/evidence-urls", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            balanceImagePath: selectedComplaint.evidence.balance_image_path,
            momoReceiptPath: selectedComplaint.evidence.momo_receipt_path,
          }),
        })

        if (response.ok) {
          const urls = await response.json()
          setEvidenceUrls(urls)
          console.log("[ADMIN-COMPLAINTS] Evidence URLs regenerated successfully")
        } else {
          console.error("Failed to regenerate evidence URLs")
        }
      } catch (error) {
        console.error("Error regenerating evidence URLs:", error)
      }
    }

    if (showModal && selectedComplaint) {
      regenerateEvidenceUrls()
    }
  }, [showModal, selectedComplaint])

  const loadComplaints = async () => {
    try {
      setLoading(true)
      const data = await complaintService.getAllComplaints()
      setComplaints(data || [])
    } catch (error) {
      console.error("Error loading complaints:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load complaints"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleResolve = async (complaint: Complaint) => {
    if (!resolutionNotes.trim()) {
      toast.error("Please enter resolution notes")
      return
    }

    try {
      setResolvingId(complaint.id)
      console.log("Resolving complaint:", complaint.id, {
        status: "resolved",
        resolution_notes: resolutionNotes,
        updated_at: new Date().toISOString(),
      })
      
      const data = await complaintService.updateComplaint(complaint.id, {
        status: "resolved",
        resolution_notes: resolutionNotes,
        updated_at: new Date().toISOString(),
      })

      // Send notification to user via admin API endpoint
      try {
        const notificationData = notificationTemplates.complaintResolved(complaint.id, resolutionNotes)
        const notifResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/notifications/create-admin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: complaint.user_id,
            title: notificationData.title,
            message: notificationData.message,
            type: notificationData.type,
            reference_id: notificationData.reference_id,
            action_url: `/dashboard/complaints?id=${complaint.id}`,
          }),
        })
        if (notifResponse.ok) {
          console.log("[NOTIFICATION] Complaint resolution notification sent to user", complaint.user_id)
        } else {
          const errorData = await notifResponse.json()
          console.warn("[NOTIFICATION] Failed to send notification:", errorData.error)
        }
      } catch (notifError) {
        console.warn("[NOTIFICATION] Failed to send notification:", notifError)
        // Don't fail the resolution if notification fails
      }

      console.log("Update response:", data)

      setComplaints(
        complaints.map((c) => (c.id === complaint.id ? data : c))
      )
      setStatusFilter("all")
      setShowModal(false)
      setResolutionNotes("")
      setSelectedComplaint(null)
      toast.success("Complaint resolved successfully")
    } catch (error) {
      console.error("Error resolving complaint:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to resolve complaint"
      toast.error(errorMessage)
    } finally {
      setResolvingId(null)
    }
  }

  const handleReject = async (complaint: Complaint) => {
    try {
      setResolvingId(complaint.id)
      const data = await complaintService.updateComplaint(complaint.id, {
        status: "rejected",
        resolution_notes: "This complaint has been rejected by the administrator.",
        updated_at: new Date().toISOString(),
      })

      // Send notification to user via admin API endpoint
      try {
        const notificationData = notificationTemplates.complaintRejected(complaint.id, complaint.title)
        const notifResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/notifications/create-admin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: complaint.user_id,
            title: notificationData.title,
            message: notificationData.message,
            type: notificationData.type,
            reference_id: notificationData.reference_id,
            action_url: `/dashboard/complaints?id=${complaint.id}`,
          }),
        })
        if (notifResponse.ok) {
          console.log("[NOTIFICATION] Complaint rejection notification sent to user", complaint.user_id)
        } else {
          const errorData = await notifResponse.json()
          console.warn("[NOTIFICATION] Failed to send notification:", errorData.error)
        }
      } catch (notifError) {
        console.warn("[NOTIFICATION] Failed to send notification:", notifError)
        // Don't fail the rejection if notification fails
      }

      setComplaints(
        complaints.map((c) => (c.id === complaint.id ? data : c))
      )
      setStatusFilter("all")
      setShowModal(false)
      setSelectedComplaint(null)
      setResolutionNotes("")
      toast.success("Complaint rejected")
    } catch (error) {
      console.error("Error rejecting complaint:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to reject complaint"
      toast.error(errorMessage)
    } finally {
      setResolvingId(null)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case "pending":
        return "bg-yellow-100 text-yellow-800"
      case "resolved":
        return "bg-green-100 text-green-800"
      case "rejected":
        return "bg-red-100 text-red-800"
      case "in-progress":
        return "bg-blue-100 text-blue-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const getPriorityColor = (priority: string) => {
    switch (priority?.toLowerCase()) {
      case "high":
        return "bg-red-100 text-red-800"
      case "medium":
        return "bg-orange-100 text-orange-800"
      case "low":
        return "bg-green-100 text-green-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status?.toLowerCase()) {
      case "pending":
        return <Clock className="w-4 h-4" />
      case "resolved":
        return <CheckCircle className="w-4 h-4" />
      case "rejected":
        return <X className="w-4 h-4" />
      case "in-progress":
        return <AlertCircle className="w-4 h-4" />
      default:
        return <AlertCircle className="w-4 h-4" />
    }
  }

  const filteredComplaints = complaints.filter((complaint) => {
    const matchesStatus = statusFilter === "all" || complaint?.status === statusFilter
    const matchesPriority = priorityFilter === "all" || complaint?.priority === priorityFilter
    const matchesSearch =
      searchTerm === "" ||
      complaint?.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      complaint?.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      complaint?.user?.email?.toLowerCase().includes(searchTerm.toLowerCase())

    return matchesStatus && matchesPriority && matchesSearch
  })

  const stats = {
    total: complaints.length,
    pending: complaints.filter((c) => c?.status === "pending").length,
    resolved: complaints.filter((c) => c?.status === "resolved").length,
    rejected: complaints.filter((c) => c?.status === "rejected").length,
  }

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  if (!isAdmin) {
    return null
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-red-600 via-purple-600 to-pink-600 bg-clip-text text-transparent">
            Customer Complaints
          </h1>
          <p className="text-gray-600 mt-1">View and rectify customer complaints</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 sm:gap-3 lg:gap-4">
          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-blue-500">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Complaints</CardTitle>
              <AlertCircle className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
              <p className="text-xs text-gray-600">All complaints</p>
            </CardContent>
          </Card>

          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-yellow-500">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="h-4 w-4 text-yellow-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.pending}</div>
              <p className="text-xs text-gray-600">Awaiting action</p>
            </CardContent>
          </Card>

          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-green-500">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Resolved</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.resolved}</div>
              <p className="text-xs text-gray-600">Completed</p>
            </CardContent>
          </Card>

          <Card className="hover:shadow-2xl transition-all duration-300 hover:-translate-y-1 border-l-4 border-l-red-500">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Rejected</CardTitle>
              <X className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.rejected}</div>
              <p className="text-xs text-gray-600">Not approved</p>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:gap-4">
              <div>
                <Label htmlFor="search">Search</Label>
                <Input
                  id="search"
                  placeholder="Search by title, description, or email..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="status">Status</Label>
                <select
                  id="status"
                  title="Filter by status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="all">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="in-progress">In Progress</option>
                  <option value="resolved">Resolved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <div>
                <Label htmlFor="priority">Priority</Label>
                <select
                  id="priority"
                  title="Filter by priority"
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="all">All Priorities</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Complaints List */}
        <Card>
          <CardHeader>
            <CardTitle>All Complaints</CardTitle>
            <CardDescription>
              {filteredComplaints.length} complaint{filteredComplaints.length !== 1 ? "s" : ""} found
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : filteredComplaints.length === 0 ? (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>No complaints found</AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-3">
                {filteredComplaints.filter(c => c && c.id).map((complaint) => (
                  <Card
                    key={complaint.id}
                    className="hover:shadow-md transition-shadow overflow-hidden"
                  >
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 space-y-2">
                          <div className="flex items-start gap-3">
                            <div>
                              <h3 className="font-semibold text-gray-900">{complaint?.title || 'N/A'}</h3>
                              <p className="text-sm text-gray-600 mt-1">{complaint?.description || 'N/A'}</p>
                              <div className="flex items-center gap-2 mt-3 flex-wrap">
                                <Badge className={`inline-flex gap-1 ${getStatusColor(complaint?.status)}`}>
                                  {getStatusIcon(complaint?.status)}
                                  {(complaint?.status || 'pending').charAt(0).toUpperCase() + (complaint?.status || 'pending').slice(1)}
                                </Badge>
                                <Badge className={`inline-flex gap-1 ${getPriorityColor(complaint?.priority)}`}>
                                  {(complaint?.priority || 'medium').charAt(0).toUpperCase() + (complaint?.priority || 'medium').slice(1)} Priority
                                </Badge>
                                {complaint?.user && (
                                  <span className="text-xs text-gray-600">
                                    From: <span className="font-medium">{complaint.user.email}</span>
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-gray-500 mt-2">
                                Submitted: {complaint?.created_at ? new Date(complaint.created_at).toLocaleDateString() : 'N/A'}
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <Button
                            onClick={() => {
                              setSelectedComplaint(complaint)
                              setResolutionNotes(complaint?.resolution_notes || "")
                              setShowModal(true)
                            }}
                            size="sm"
                            variant="outline"
                            className="gap-2"
                          >
                            <Eye className="w-4 h-4" />
                            View & Resolve
                          </Button>
                          {complaint.status === "pending" && (
                            <Button
                              onClick={() => handleReject(complaint)}
                              disabled={resolvingId === complaint.id}
                              size="sm"
                              variant="destructive"
                            >
                              {resolvingId === complaint.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <X className="w-4 h-4" />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Resolution Modal */}
        <Dialog open={showModal} onOpenChange={setShowModal}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto w-[95vw] sm:w-full">
            <DialogHeader>
              <DialogTitle>Resolve Complaint</DialogTitle>
              <DialogDescription>
                Provide resolution details for this complaint
              </DialogDescription>
            </DialogHeader>

            {selectedComplaint && (
              <div className="space-y-4 sm:space-y-6">
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs font-semibold text-gray-600 uppercase">
                      Complaint Title
                    </Label>
                    <p className="text-lg font-semibold mt-1">{selectedComplaint?.title || 'N/A'}</p>
                  </div>

                  <div>
                    <Label className="text-xs font-semibold text-gray-600 uppercase">
                      Description
                    </Label>
                    <p className="text-sm text-gray-600 mt-1">
                      {selectedComplaint?.description || 'N/A'}
                    </p>
                  </div>

                  {selectedComplaint.order_details && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4">
                      <div>
                        <Label className="text-xs font-semibold text-gray-600 uppercase">
                          Phone Number
                        </Label>
                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 mt-1">
                          <p className="text-sm font-mono bg-gray-100 px-3 py-2 rounded break-all flex-1">
                            {selectedComplaint.order_details.phone || selectedComplaint.order_details.phoneNumber || 'N/A'}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              navigator.clipboard.writeText(selectedComplaint.order_details?.phone || selectedComplaint.order_details?.phoneNumber || '')
                              toast.success("Phone number copied!")
                            }}
                            className="flex-shrink-0"
                          >
                            Copy
                          </Button>
                        </div>
                      </div>
                      <div>
                        <Label className="text-xs font-semibold text-gray-600 uppercase">
                          Data Size
                        </Label>
                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 mt-1">
                          <p className="text-sm font-mono bg-gray-100 px-3 py-2 rounded flex-1">
                            {selectedComplaint.order_details.package || selectedComplaint.order_details.packageName || 'N/A'}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              navigator.clipboard.writeText(selectedComplaint.order_details?.package || selectedComplaint.order_details?.packageName || '')
                              toast.success("Data size copied!")
                            }}
                            className="flex-shrink-0"
                          >
                            Copy
                          </Button>
                        </div>
                      </div>
                      {selectedComplaint.order_details.date && (
                        <div>
                          <Label className="text-xs font-semibold text-gray-600 uppercase">
                            Order Date
                          </Label>
                          <p className="text-sm font-mono bg-gray-100 px-3 py-2 rounded mt-1">
                            {new Date(selectedComplaint.order_details.date).toLocaleString()}
                          </p>
                        </div>
                      )}
                      {selectedComplaint.order_details.network && (
                        <div>
                          <Label className="text-xs font-semibold text-gray-600 uppercase">
                            Network
                          </Label>
                          <p className="text-sm font-mono bg-gray-100 px-3 py-2 rounded mt-1">
                            {selectedComplaint.order_details.network}
                          </p>
                        </div>
                      )}
                      {selectedComplaint.order_details.amount && (
                        <div>
                          <Label className="text-xs font-semibold text-gray-600 uppercase">
                            Amount
                          </Label>
                          <p className="text-sm font-mono bg-gray-100 px-3 py-2 rounded mt-1">
                            ₵ {selectedComplaint.order_details.amount.toFixed(2)}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4">
                      <div>
                        <Label className="text-xs font-semibold text-gray-600 uppercase">
                          Status
                        </Label>
                        <Badge
                          className={`mt-1 inline-flex gap-1 ${getStatusColor(
                            selectedComplaint?.status || 'pending'
                          )}`}
                        >
                          {getStatusIcon(selectedComplaint?.status || 'pending')}
                          {(selectedComplaint?.status || 'pending').charAt(0).toUpperCase() +
                            (selectedComplaint?.status || 'pending').slice(1)}
                        </Badge>
                      </div>

                      <div>
                        <Label className="text-xs font-semibold text-gray-600 uppercase">
                          Priority
                        </Label>
                        <Badge
                          className={`mt-1 inline-flex gap-1 ${getPriorityColor(
                            selectedComplaint?.priority || 'medium'
                          )}`}
                        >
                          {(selectedComplaint?.priority || 'medium').charAt(0).toUpperCase() +
                            (selectedComplaint?.priority || 'medium').slice(1)}
                        </Badge>
                      </div>
                    </div>

                  {/* Timestamps */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4">
                    <div>
                      <Label className="text-xs font-semibold text-gray-600 uppercase">
                        Submitted
                      </Label>
                      <p className="text-sm mt-1 text-gray-700">
                        {selectedComplaint?.created_at 
                          ? new Date(selectedComplaint.created_at).toLocaleString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: true
                            })
                          : 'N/A'}
                      </p>
                    </div>
                    <div>
                      <Label className="text-xs font-semibold text-gray-600 uppercase">
                        Last Updated
                      </Label>
                      <p className="text-sm mt-1 text-gray-700">
                        {selectedComplaint?.updated_at 
                          ? new Date(selectedComplaint.updated_at).toLocaleString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: true
                            })
                          : 'N/A'}
                      </p>
                    </div>
                  </div>

                  {selectedComplaint?.user && (
                    <div>
                      <Label className="text-xs font-semibold text-gray-600 uppercase">
                        Customer
                      </Label>
                      <p className="text-sm mt-1">
                        <span className="text-gray-600">{selectedComplaint.user.email || 'N/A'}</span>
                      </p>
                    </div>
                  )}

                  {/* Evidence Images */}
                  {selectedComplaint?.evidence && (
                    <div className="border-t pt-3 sm:pt-4">
                      <Label className="text-sm font-semibold mb-2 sm:mb-3 block">
                        Evidence Attachments
                      </Label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4">
                        {(evidenceUrls.balance_image_url || selectedComplaint.evidence.balance_image_url) && (
                          <div className="space-y-2">
                            <p className="text-xs font-medium text-gray-600">Balance Screenshot</p>
                            <a 
                              href={evidenceUrls.balance_image_url || selectedComplaint.evidence.balance_image_url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="block"
                            >
                              <img 
                                src={evidenceUrls.balance_image_url || selectedComplaint.evidence.balance_image_url} 
                                alt="Balance Screenshot" 
                                className="w-full h-32 sm:h-48 object-cover rounded-lg border border-gray-200 hover:opacity-90 cursor-pointer"
                                onError={(e) => {
                                  console.error("Error loading balance image:", e)
                                }}
                              />
                            </a>
                          </div>
                        )}
                        {(evidenceUrls.momo_receipt_url || selectedComplaint.evidence.momo_receipt_url) && (
                          <div className="space-y-2">
                            <p className="text-xs font-medium text-gray-600">MoMo Receipt</p>
                            <a 
                              href={evidenceUrls.momo_receipt_url || selectedComplaint.evidence.momo_receipt_url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="block"
                            >
                              <img 
                                src={evidenceUrls.momo_receipt_url || selectedComplaint.evidence.momo_receipt_url} 
                                alt="MoMo Receipt" 
                                className="w-full h-32 sm:h-48 object-cover rounded-lg border border-gray-200 hover:opacity-90 cursor-pointer"
                                onError={(e) => {
                                  console.error("Error loading momo receipt image:", e)
                                }}
                              />
                            </a>
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-2">Click images to view full size</p>
                    </div>
                  )}
                </div>

                <div className="border-t pt-3 sm:pt-4">
                  <Label htmlFor="notes" className="text-sm font-semibold">
                    Resolution Notes *
                  </Label>
                  <textarea
                    id="notes"
                    value={resolutionNotes}
                    onChange={(e) => setResolutionNotes(e.target.value)}
                    placeholder="Explain how you resolved this complaint..."
                    className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                    rows={4}
                  />
                </div>

                <div className="flex flex-col sm:flex-row gap-2 justify-end">
                  <Button
                    onClick={() => setShowModal(false)}
                    variant="outline"
                    className="w-full sm:w-auto"
                  >
                    Cancel
                  </Button>
                  {selectedComplaint?.status === "pending" && (
                    <Button
                      onClick={() => selectedComplaint && handleReject(selectedComplaint)}
                      disabled={resolvingId === selectedComplaint?.id}
                      variant="destructive"
                      className="gap-2 w-full sm:w-auto"
                    >
                      {resolvingId === selectedComplaint?.id ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Rejecting...
                        </>
                      ) : (
                        <>
                          <X className="w-4 h-4" />
                          Reject Complaint
                        </>
                      )}
                    </Button>
                  )}
                  <Button
                    onClick={() => selectedComplaint && handleResolve(selectedComplaint)}
                    disabled={resolvingId === selectedComplaint?.id}
                    className="gap-2 w-full sm:w-auto bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
                  >
                    {resolvingId === selectedComplaint?.id ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Resolving...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-4 h-4" />
                        Mark as Resolved
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
