"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { useIsAdmin } from "@/hooks/use-admin"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Copy, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff, Filter, Download } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface AFASubmission {
  id: string
  user_id: string
  order_code: string
  transaction_code: string
  full_name: string
  phone_number: string
  amount: number
  status: string
  user_email?: string
  created_at: string
}

export default function AFARegistrationsAdminPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const { isAdmin, loading: adminLoading } = useIsAdmin()
  const [submissions, setSubmissions] = useState<AFASubmission[]>([])
  const [filteredSubmissions, setFilteredSubmissions] = useState<AFASubmission[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedSubmission, setSelectedSubmission] = useState<AFASubmission | null>(null)
  const [showDetailsModal, setShowDetailsModal] = useState(false)
  const [showPhoneNumbers, setShowPhoneNumbers] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)

  // Auth and admin protection
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/auth/login")
    } else if (!adminLoading && !isAdmin) {
      router.push("/dashboard")
    }
  }, [user, authLoading, isAdmin, adminLoading, router])

  // Fetch AFA submissions
  useEffect(() => {
    if (user && isAdmin) {
      fetchSubmissions()
    }
  }, [user, isAdmin])

  // Filter submissions
  useEffect(() => {
    let filtered = submissions

    if (statusFilter !== "all") {
      filtered = filtered.filter((s) => s.status === statusFilter)
    }

    if (searchTerm) {
      const search = searchTerm.toLowerCase()
      filtered = filtered.filter(
        (s) =>
          s.full_name.toLowerCase().includes(search) ||
          s.phone_number.includes(search) ||
          s.order_code.toLowerCase().includes(search) ||
          s.transaction_code.toLowerCase().includes(search) ||
          s.user_email?.toLowerCase().includes(search)
      )
    }

    setFilteredSubmissions(filtered)
  }, [submissions, statusFilter, searchTerm])

  const fetchSubmissions = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No session")

      const response = await fetch("/api/admin/afa-registrations", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      })

      if (!response.ok) throw new Error("Failed to fetch submissions")

      const data = await response.json()
      setSubmissions(data.submissions || [])
    } catch (error) {
      console.error("Error fetching submissions:", error)
      toast.error("Failed to load AFA submissions")
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = (text: string, fieldName: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(fieldName)
    toast.success(`${fieldName} copied to clipboard`)
    setTimeout(() => setCopiedField(null), 2000)
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  const getStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case "pending":
        return <Badge className="bg-yellow-100 text-yellow-800">Pending</Badge>
      case "processing":
        return <Badge className="bg-blue-100 text-blue-800">Processing</Badge>
      case "completed":
        return <Badge className="bg-green-100 text-green-800">Completed</Badge>
      case "cancelled":
        return <Badge className="bg-red-100 text-red-800">Cancelled</Badge>
      default:
        return <Badge>{status}</Badge>
    }
  }

  const handleViewDetails = (submission: AFASubmission) => {
    setSelectedSubmission(submission)
    setShowDetailsModal(true)
    setShowPhoneNumbers(false)
  }

  if (authLoading || adminLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    )
  }

  if (!isAdmin) {
    return null
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">AFA Registrations</h1>
          <p className="text-gray-600 mt-1">Manage MTN AFA registration submissions</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Total Submissions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{submissions.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {submissions.filter((s) => s.status === "pending").length}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Processing</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {submissions.filter((s) => s.status === "processing").length}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Completed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {submissions.filter((s) => s.status === "completed").length}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Filters & Search</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">Search</label>
                <Input
                  placeholder="Search by name, phone, order code..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Status Filter</label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="processing">Processing</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Submissions Table */}
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <div>
                <CardTitle>Submissions</CardTitle>
                <CardDescription>
                  Showing {filteredSubmissions.length} of {submissions.length} submissions
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-8 h-8 animate-spin" />
              </div>
            ) : filteredSubmissions.length === 0 ? (
              <div className="text-center py-8">
                <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-2" />
                <p className="text-gray-600">No submissions found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">Order Code</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">Name</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">Phone</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">Amount</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">Date</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-900">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredSubmissions.map((submission) => (
                      <tr key={submission.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-semibold text-blue-600">
                          {submission.order_code}
                        </td>
                        <td className="px-4 py-3 text-sm">{submission.full_name}</td>
                        <td className="px-4 py-3 text-sm font-mono text-gray-600">
                          {submission.phone_number.substring(0, 3)}...
                        </td>
                        <td className="px-4 py-3 text-sm font-semibold">
                          GHS {submission.amount.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {getStatusBadge(submission.status)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {formatDate(submission.created_at)}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleViewDetails(submission)}
                          >
                            View Details
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Details Modal */}
      <Dialog open={showDetailsModal} onOpenChange={setShowDetailsModal}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Submission Details</DialogTitle>
            <DialogDescription>
              Order Code: {selectedSubmission?.order_code}
            </DialogDescription>
          </DialogHeader>

          {selectedSubmission && (
            <div className="space-y-6">
              {/* Status Badge */}
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Status:</span>
                {getStatusBadge(selectedSubmission.status)}
              </div>

              {/* Details Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Order Code */}
                <div>
                  <label className="text-sm font-medium text-gray-700 block mb-2">
                    Order Code
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={selectedSubmission.order_code}
                      readOnly
                      className="flex-1 font-mono"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() =>
                        copyToClipboard(selectedSubmission.order_code, "Order Code")
                      }
                    >
                      {copiedField === "Order Code" ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Transaction Code */}
                <div>
                  <label className="text-sm font-medium text-gray-700 block mb-2">
                    Transaction Code
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={selectedSubmission.transaction_code}
                      readOnly
                      className="flex-1 font-mono"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() =>
                        copyToClipboard(
                          selectedSubmission.transaction_code,
                          "Transaction Code"
                        )
                      }
                    >
                      {copiedField === "Transaction Code" ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Full Name */}
                <div>
                  <label className="text-sm font-medium text-gray-700 block mb-2">
                    Full Name
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={selectedSubmission.full_name}
                      readOnly
                      className="flex-1"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() =>
                        copyToClipboard(selectedSubmission.full_name, "Full Name")
                      }
                    >
                      {copiedField === "Full Name" ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Amount */}
                <div>
                  <label className="text-sm font-medium text-gray-700 block mb-2">
                    Amount
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={`GHS ${selectedSubmission.amount.toFixed(2)}`}
                      readOnly
                      className="flex-1"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() =>
                        copyToClipboard(
                          selectedSubmission.amount.toFixed(2),
                          "Amount"
                        )
                      }
                    >
                      {copiedField === "Amount" ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Phone Number */}
                <div className="md:col-span-2">
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-sm font-medium text-gray-700">
                      Phone Number
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setShowPhoneNumbers(!showPhoneNumbers)}
                      className="h-auto p-0"
                    >
                      {showPhoneNumbers ? (
                        <EyeOff className="w-4 h-4 mr-1" />
                      ) : (
                        <Eye className="w-4 h-4 mr-1" />
                      )}
                      {showPhoneNumbers ? "Hide" : "Show"}
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={
                        showPhoneNumbers
                          ? selectedSubmission.phone_number
                          : "••••••••••"
                      }
                      readOnly
                      className="flex-1 font-mono"
                      type={showPhoneNumbers ? "text" : "password"}
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() =>
                        copyToClipboard(
                          selectedSubmission.phone_number,
                          "Phone Number"
                        )
                      }
                    >
                      {copiedField === "Phone Number" ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Email */}
                {selectedSubmission.user_email && (
                  <div className="md:col-span-2">
                    <label className="text-sm font-medium text-gray-700 block mb-2">
                      User Email
                    </label>
                    <div className="flex gap-2">
                      <Input
                        value={selectedSubmission.user_email}
                        readOnly
                        className="flex-1"
                      />
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() =>
                          copyToClipboard(
                            selectedSubmission.user_email || "",
                            "Email"
                          )
                        }
                      >
                        {copiedField === "Email" ? (
                          <CheckCircle2 className="w-4 h-4" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Date */}
                <div className="md:col-span-2">
                  <label className="text-sm font-medium text-gray-700 block mb-2">
                    Submitted Date
                  </label>
                  <Input
                    value={formatDate(selectedSubmission.created_at)}
                    readOnly
                    className="w-full"
                  />
                </div>
              </div>

              {/* Info Alert */}
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Payment of GHS {selectedSubmission.amount.toFixed(2)} has been deducted from the user's wallet.
                </AlertDescription>
              </Alert>

              {/* Close Button */}
              <Button onClick={() => setShowDetailsModal(false)} className="w-full">
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
