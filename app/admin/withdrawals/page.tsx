"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { CheckCircle, XCircle, Clock, AlertCircle, Copy, Loader2 } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { toast } from "sonner"

interface WithdrawalRequest {
  id: string
  shop_id: string
  user_id: string
  amount: number
  fee_amount?: number
  net_amount?: number
  withdrawal_method: string
  account_details: any
  status: "pending" | "approved" | "rejected" | "completed"
  reference_code: string
  rejection_reason?: string
  created_at: string
  updated_at: string
  user_shops?: {
    shop_name: string
    shop_slug: string
  }
}

export default function WithdrawalsPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedWithdrawal, setSelectedWithdrawal] = useState<WithdrawalRequest | null>(null)
  const [rejectionReason, setRejectionReason] = useState("")
  const [approvalLoading, setApprovalLoading] = useState(false)
  const [filterStatus, setFilterStatus] = useState<string>("pending")

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadWithdrawals()
    }
  }, [isAdmin, adminLoading, filterStatus])

  const loadWithdrawals = async () => {
    try {
      setLoading(true)
      
      const response = await fetch(`/api/admin/withdrawals/list?status=${filterStatus}`)
      
      if (!response.ok) {
        throw new Error("Failed to fetch withdrawals")
      }

      const data = await response.json()
      
      console.log("[WITHDRAWALS] Loaded:", data.length, "withdrawals for status:", filterStatus)
      setWithdrawals(data || [])
    } catch (error) {
      console.error("Error loading withdrawals:", error)
      toast.error("Failed to load withdrawal requests")
    } finally {
      setLoading(false)
    }
  }

  const approveWithdrawal = async (withdrawalId: string) => {
    try {
      setApprovalLoading(true)

      const response = await fetch("/api/admin/withdrawals/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ withdrawalId }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to approve withdrawal")
      }

      toast.success("Withdrawal approved successfully")
      setSelectedWithdrawal(null)
      loadWithdrawals()
    } catch (error) {
      console.error("Error approving withdrawal:", error)
      toast.error(error instanceof Error ? error.message : "Failed to approve withdrawal")
    } finally {
      setApprovalLoading(false)
    }
  }

  const rejectWithdrawal = async (withdrawalId: string) => {
    if (!rejectionReason.trim()) {
      toast.error("Please provide a rejection reason")
      return
    }

    try {
      setApprovalLoading(true)

      const response = await fetch("/api/admin/withdrawals/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ withdrawalId, reason: rejectionReason }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to reject withdrawal")
      }

      toast.success("Withdrawal rejected successfully")
      setSelectedWithdrawal(null)
      setRejectionReason("")
      loadWithdrawals()
    } catch (error) {
      console.error("Error rejecting withdrawal:", error)
      toast.error(error instanceof Error ? error.message : "Failed to reject withdrawal")
    } finally {
      setApprovalLoading(false)
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "approved":
        return <CheckCircle className="h-4 w-4 text-green-600" />
      case "rejected":
        return <XCircle className="h-4 w-4 text-red-600" />
      case "completed":
        return <CheckCircle className="h-4 w-4 text-blue-600" />
      default:
        return <Clock className="h-4 w-4 text-orange-600" />
    }
  }

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-orange-100 text-orange-800"
      case "approved":
        return "bg-green-100 text-green-800"
      case "rejected":
        return "bg-red-100 text-red-800"
      case "completed":
        return "bg-blue-100 text-blue-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast.success(`${label} copied to clipboard`)
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
          <h1 className="text-4xl font-bold bg-gradient-to-r from-red-600 via-purple-600 to-pink-600 bg-clip-text text-transparent">
            Withdrawal Approvals
          </h1>
          <p className="text-gray-500 mt-1 font-medium">Manage shop withdrawal requests</p>
        </div>

        {/* Filter Buttons */}
        <div className="flex gap-2 flex-wrap">
          {["pending", "approved", "rejected", "completed", "all"].map((status) => (
            <Button
              key={status}
              variant={filterStatus === status ? "default" : "outline"}
              onClick={() => setFilterStatus(status)}
              className={filterStatus === status ? "bg-purple-600 hover:bg-purple-700" : ""}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Button>
          ))}
        </div>

        {/* Withdrawals Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-gray-500">Loading withdrawal requests...</div>
          </div>
        ) : withdrawals.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center text-gray-500">
              No withdrawal requests found
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {withdrawals.map((withdrawal) => (
              <Card key={withdrawal.id} className="hover:shadow-lg transition-all">
                <CardContent className="pt-6">
                  <div className="space-y-4">
                    {/* Header */}
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          {getStatusIcon(withdrawal.status)}
                          <h3 className="font-semibold text-lg">
                            {withdrawal.user_shops?.shop_name || "Shop"}
                          </h3>
                          <Badge className={getStatusBadgeColor(withdrawal.status)}>
                            {withdrawal.status.toUpperCase()}
                          </Badge>
                        </div>
                        <p className="text-xs text-gray-500">{withdrawal.reference_code}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-gray-900">GHS {withdrawal.amount.toFixed(2)}</p>
                        <p className="text-xs text-gray-600 capitalize">{withdrawal.withdrawal_method}</p>
                        {withdrawal.fee_amount && withdrawal.fee_amount > 0 && (
                          <p className="text-xs text-orange-600 font-medium mt-1">Fee: GHS {withdrawal.fee_amount.toFixed(2)}</p>
                        )}
                        {withdrawal.net_amount && (
                          <p className="text-xs text-green-600 font-semibold mt-1">Payout: GHS {withdrawal.net_amount.toFixed(2)}</p>
                        )}
                      </div>
                    </div>

                    {/* Processing Details */}
                    <div className="border-t pt-4">
                      <p className="text-xs font-semibold text-gray-900 mb-3">Processing Details</p>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                        {/* Account Name */}
                        <div>
                          <p className="text-xs text-gray-600 mb-1">Account Name</p>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 bg-blue-50 p-2 rounded border border-blue-200">
                              <p className="font-mono text-sm text-gray-900">
                                {withdrawal.account_details?.account_name || "N/A"}
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => copyToClipboard(withdrawal.account_details?.account_name || "", "Account Name")}
                              className="h-8 w-8 p-0"
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>

                        {/* Mobile Money Number */}
                        {withdrawal.withdrawal_method === "mobile_money" && (
                          <>
                            <div>
                              <p className="text-xs text-gray-600 mb-1">Mobile Number</p>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 bg-green-50 p-2 rounded border border-green-200">
                                  <p className="font-mono text-sm text-gray-900">
                                    {withdrawal.account_details?.phone || "N/A"}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => copyToClipboard(withdrawal.account_details?.phone || "", "Mobile Number")}
                                  className="h-8 w-8 p-0"
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>
                            <div>
                              <p className="text-xs text-gray-600 mb-1">Network</p>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 bg-orange-50 p-2 rounded border border-orange-200">
                                  <p className="font-mono text-sm font-semibold text-gray-900">
                                    {withdrawal.account_details?.network || "N/A"}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => copyToClipboard(withdrawal.account_details?.network || "", "Network")}
                                  className="h-8 w-8 p-0"
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>
                          </>
                        )}

                        {/* Bank Details */}
                        {withdrawal.withdrawal_method === "bank_transfer" && (
                          <>
                            <div>
                              <p className="text-xs text-gray-600 mb-1">Bank Name</p>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 bg-purple-50 p-2 rounded border border-purple-200">
                                  <p className="font-mono text-sm text-gray-900">
                                    {withdrawal.account_details?.bank_name || "N/A"}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => copyToClipboard(withdrawal.account_details?.bank_name || "", "Bank Name")}
                                  className="h-8 w-8 p-0"
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>

                            <div>
                              <p className="text-xs text-gray-600 mb-1">Account Number</p>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 bg-orange-50 p-2 rounded border border-orange-200">
                                  <p className="font-mono text-sm text-gray-900">
                                    {withdrawal.account_details?.account_number || "N/A"}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => copyToClipboard(withdrawal.account_details?.account_number || "", "Account Number")}
                                  className="h-8 w-8 p-0"
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Dates */}
                      <div className="grid grid-cols-2 gap-2 text-xs mb-4 pb-4 border-b">
                        <div>
                          <p className="text-gray-600">Requested</p>
                          <p className="font-semibold text-gray-900">
                            {new Date(withdrawal.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div>
                          <p className="text-gray-600">Updated</p>
                          <p className="font-semibold text-gray-900">
                            {new Date(withdrawal.updated_at).toLocaleDateString()}
                          </p>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      {withdrawal.status === "pending" && (
                        <div className="flex gap-2">
                          <Button
                            onClick={() => approveWithdrawal(withdrawal.id)}
                            disabled={approvalLoading}
                            className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm"
                          >
                            {approvalLoading ? "Processing..." : "✓ Approve"}
                          </Button>
                          <Button
                            onClick={() => {
                              setSelectedWithdrawal(withdrawal)
                              setRejectionReason("")
                            }}
                            variant="outline"
                            className="flex-1 text-sm border-red-300 text-red-600 hover:bg-red-50"
                          >
                            ✕ Reject
                          </Button>
                        </div>
                      )}

                      {/* Rejection Reason Display */}
                      {withdrawal.status === "rejected" && withdrawal.rejection_reason && (
                        <div className="bg-red-50 p-3 rounded border border-red-200">
                          <p className="text-xs font-semibold text-red-900 mb-1">Rejection Reason</p>
                          <p className="text-sm text-red-800">{withdrawal.rejection_reason}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Rejection Reason Modal */}
        {selectedWithdrawal && selectedWithdrawal.status === "pending" && (
          <Card className="border-2 border-red-300 fixed inset-0 m-auto max-w-md max-h-96 z-50">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Reject Withdrawal</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedWithdrawal(null)
                    setRejectionReason("")
                  }}
                >
                  ✕
                </Button>
              </div>
              <CardDescription>
                {selectedWithdrawal.user_shops?.shop_name} - GHS {selectedWithdrawal.amount.toFixed(2)}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Rejection Reason *</Label>
                <Textarea
                  placeholder="Enter reason for rejection"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  className="min-h-[100px]"
                />
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={() => rejectWithdrawal(selectedWithdrawal.id)}
                  disabled={approvalLoading || !rejectionReason.trim()}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                >
                  {approvalLoading ? "Processing..." : "✕ Reject"}
                </Button>
                <Button
                  onClick={() => {
                    setSelectedWithdrawal(null)
                    setRejectionReason("")
                  }}
                  variant="outline"
                  className="flex-1"
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  )
}
