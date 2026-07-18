"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CheckCircle, XCircle, Clock, Copy, Loader2, AlertTriangle, Wallet, ShieldCheck, ShieldX } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
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
  status: "pending" | "approved" | "rejected" | "completed" | "processing" | "failed"
  moolre_transfer_id?: string
  reference_code: string
  rejection_reason?: string
  created_at: string
  updated_at: string
  user_shops?: { shop_name: string; shop_slug: string }
  current_available_balance?: number
}

interface BulkResult {
  id: string
  shopName: string
  amount: number
  success: boolean
  status: string
  message: string
}

interface NameValidation {
  validatedName: string | null
  claimedName: string
  matched: boolean
  error?: string | null
}

const SELECTABLE_STATUSES = ["pending", "failed"]

export default function WithdrawalsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedWithdrawal, setSelectedWithdrawal] = useState<WithdrawalRequest | null>(null)
  const [rejectionReason, setRejectionReason] = useState("")
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>("pending")

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Name validation
  const [validatingId, setValidatingId] = useState<string | null>(null)
  const [validatedNames, setValidatedNames] = useState<Record<string, NameValidation>>({})

  // Solvency banner
  const [moolreBalance, setMoolreBalance] = useState<number | null>(null)
  const [loadingMoolreBalance, setLoadingMoolreBalance] = useState(false)

  // Bulk approve
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null)

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      loadWithdrawals()
    }
  }, [isAdmin, adminLoading, filterStatus])

  // Clear selection when filter changes
  useEffect(() => {
    setSelectedIds(new Set())
  }, [filterStatus])

  // Load Moolre balance when viewing pending
  useEffect(() => {
    if (isAdmin && filterStatus === "pending") {
      loadMoolreBalance()
    } else {
      setMoolreBalance(null)
    }
  }, [isAdmin, filterStatus])

  const getSession = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session
  }

  const authHeaders = async (): Promise<Record<string, string>> => {
    const session = await getSession()
    const h: Record<string, string> = { "Content-Type": "application/json" }
    if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`
    return h
  }

  const loadWithdrawals = async () => {
    try {
      setLoading(true)
      const session = await getSession()
      const response = await fetch(`/api/admin/withdrawals/list?status=${filterStatus}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (!response.ok) throw new Error("Failed to fetch withdrawals")
      const data = await response.json()
      setWithdrawals(data || [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load withdrawal requests")
    } finally {
      setLoading(false)
    }
  }

  const loadMoolreBalance = async () => {
    try {
      setLoadingMoolreBalance(true)
      const headers = await authHeaders()
      const res = await fetch("/api/admin/withdrawals/moolre-balance", { headers })
      if (!res.ok) return
      const data = await res.json()
      setMoolreBalance(typeof data.balance === "number" ? data.balance : null)
    } catch {
      // Non-fatal — banner just won't show balance
    } finally {
      setLoadingMoolreBalance(false)
    }
  }

  const approveWithdrawal = async (withdrawalId: string, manual = false) => {
    try {
      setActionLoadingId(withdrawalId)
      const headers = await authHeaders()
      const response = await fetch("/api/admin/withdrawals/approve", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalId, manual }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to approve withdrawal")

      if (manual) {
        toast.success("Withdrawal manually approved — remember to transfer funds.")
      } else if (data.status === "processing") {
        toast.success("Transfer initiated — awaiting MoMo confirmation.")
      } else {
        toast.success("Withdrawal approved and transferred successfully")
      }
      setSelectedWithdrawal(null)
      loadWithdrawals()
      if (filterStatus === "pending") loadMoolreBalance()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to approve withdrawal")
    } finally {
      setActionLoadingId(null)
    }
  }

  const rejectWithdrawal = async (withdrawalId: string) => {
    if (!rejectionReason.trim()) { toast.error("Please provide a rejection reason"); return }
    try {
      setActionLoadingId(withdrawalId)
      const headers = await authHeaders()
      const response = await fetch("/api/admin/withdrawals/reject", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalId, reason: rejectionReason }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to reject withdrawal")
      toast.success("Withdrawal rejected successfully")
      setSelectedWithdrawal(null)
      setRejectionReason("")
      loadWithdrawals()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reject withdrawal")
    } finally {
      setActionLoadingId(null)
    }
  }

  const resetProcessing = async (withdrawalId: string) => {
    try {
      setActionLoadingId(withdrawalId)
      const headers = await authHeaders()
      const response = await fetch("/api/admin/withdrawals/reset-processing", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to reset")
      toast.success("Withdrawal reset to pending")
      loadWithdrawals()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reset withdrawal")
    } finally {
      setActionLoadingId(null)
    }
  }

  // ── Name validation ──────────────────────────────────────────────────────────
  const validateName = async (withdrawal: WithdrawalRequest) => {
    try {
      setValidatingId(withdrawal.id)
      const headers = await authHeaders()
      const res = await fetch("/api/admin/withdrawals/validate-name", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalId: withdrawal.id }),
      })
      const data = await res.json()
      setValidatedNames(prev => ({ ...prev, [withdrawal.id]: data }))
    } catch {
      setValidatedNames(prev => ({ ...prev, [withdrawal.id]: { validatedName: null, claimedName: "", matched: false, error: "Could not reach Moolre" } }))
    } finally {
      setValidatingId(null)
    }
  }

  // ── Selection ────────────────────────────────────────────────────────────────
  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    const selectable = withdrawals.filter(w => SELECTABLE_STATUSES.includes(w.status)).map(w => w.id)
    setSelectedIds(new Set(selectable))
  }

  const deselectAll = () => setSelectedIds(new Set())

  // ── Bulk approve ─────────────────────────────────────────────────────────────
  const bulkApprove = async (manual: boolean) => {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]
    try {
      setBulkLoading(true)
      const headers = await authHeaders()
      const res = await fetch("/api/admin/withdrawals/bulk-approve", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalIds: ids, manual }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || "Bulk approve failed")
        return
      }
      setBulkResults(data.results)
      setSelectedIds(new Set())
      loadWithdrawals()
      if (filterStatus === "pending") loadMoolreBalance()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk approve failed")
    } finally {
      setBulkLoading(false)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast.success(`${label} copied`)
  }

  const getStatusIcon = (status: string) => {
    if (status === "approved" || status === "completed") return <CheckCircle className="h-4 w-4 text-success" />
    if (status === "rejected" || status === "failed") return <XCircle className="h-4 w-4 text-destructive" />
    if (status === "processing") return <Loader2 className="h-4 w-4 text-primary animate-spin" />
    return <Clock className="h-4 w-4 text-warning" />
  }

  const getStatusBadgeColor = (status: string) => {
    if (status === "pending")    return "bg-warning/15 text-warning"
    if (status === "approved")   return "bg-success/15 text-success"
    if (status === "rejected" || status === "failed") return "bg-destructive/15 text-destructive"
    if (status === "completed")  return "bg-primary/10 text-primary"
    if (status === "processing") return "bg-primary/5 text-primary"
    return "bg-muted text-foreground"
  }

  // Derived values
  const canSelect = SELECTABLE_STATUSES.includes(filterStatus) || filterStatus === "all"
  const selectableWithdrawals = withdrawals.filter(w => SELECTABLE_STATUSES.includes(w.status))
  const selectedList = withdrawals.filter(w => selectedIds.has(w.id))
  const totalSelectedNet = selectedList.reduce((s, w) => s + Number(w.net_amount ?? w.amount), 0)
  const totalPending = withdrawals
    .filter(w => w.status === "pending")
    .reduce((s, w) => s + Number(w.net_amount ?? w.amount), 0)

  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  if (!isAdmin) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-primary">Withdrawal Approvals</h1>
          <p className="text-muted-foreground mt-1 font-medium">Manage shop withdrawal requests</p>
        </div>

        {/* Filter Buttons */}
        <div className="flex flex-wrap gap-2 sm:gap-3">
          {["pending", "processing", "approved", "completed", "failed", "rejected", "all"].map((status) => (
            <Button
              key={status}
              variant={filterStatus === status ? "default" : "outline"}
              onClick={() => setFilterStatus(status)}
              className={filterStatus === status ? "bg-primary hover:bg-primary" : ""}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Button>
          ))}
        </div>

        {/* Solvency Banner — only when viewing pending */}
        {filterStatus === "pending" && withdrawals.length > 0 && (
          <Card className={`border ${
            moolreBalance !== null && moolreBalance < totalPending
              ? "border-destructive/50 bg-destructive/5"
              : "border-success/30 bg-success/5"
          }`}>
            <CardContent className="py-3 px-4">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-primary" />
                  <span className="text-muted-foreground">Moolre Wallet:</span>
                  {loadingMoolreBalance ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : moolreBalance !== null ? (
                    <span className="font-bold font-mono">GHS {moolreBalance.toFixed(2)}</span>
                  ) : (
                    <span className="text-muted-foreground italic">unavailable</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Pending Payouts:</span>
                  <span className="font-bold font-mono">GHS {totalPending.toFixed(2)}</span>
                </div>
                {moolreBalance !== null && (
                  moolreBalance >= totalPending ? (
                    <Badge className="bg-success/15 text-success flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3" /> Sufficient
                    </Badge>
                  ) : (
                    <Badge className="bg-destructive/15 text-destructive flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      Shortfall GHS {(totalPending - moolreBalance).toFixed(2)}
                    </Badge>
                  )
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={loadMoolreBalance}
                  disabled={loadingMoolreBalance}
                >
                  {loadingMoolreBalance ? <Loader2 className="w-3 h-3 animate-spin" /> : "↺ Refresh"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Bulk Action Toolbar — visible when items are selected */}
        {canSelect && selectableWithdrawals.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={selectedIds.size === selectableWithdrawals.length ? deselectAll : selectAll}
              className="text-xs border-border"
            >
              {selectedIds.size === selectableWithdrawals.length ? "Deselect All" : `Select All (${selectableWithdrawals.length})`}
            </Button>

            {selectedIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 p-2 bg-primary/5 border border-primary/20 rounded-lg">
                <span className="text-xs font-medium text-foreground">
                  {selectedIds.size} selected · Payout: <span className="font-bold font-mono">GHS {totalSelectedNet.toFixed(2)}</span>
                </span>
                <Button
                  size="sm"
                  disabled={bulkLoading}
                  onClick={() => bulkApprove(false)}
                  className="h-7 px-3 text-xs bg-success hover:bg-success/90 text-primary-foreground"
                >
                  {bulkLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                  Approve Auto ({selectedIds.size})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bulkLoading}
                  onClick={() => bulkApprove(true)}
                  className="h-7 px-3 text-xs border-border text-primary hover:bg-primary/5"
                >
                  Manual Approve ({selectedIds.size})
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={deselectAll}
                  className="h-7 px-2 text-xs text-muted-foreground"
                >
                  ✕ Clear
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Withdrawals Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-muted-foreground">Loading withdrawal requests...</div>
          </div>
        ) : withdrawals.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">No withdrawal requests found</CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {withdrawals.map((withdrawal) => {
              const isSelectable = SELECTABLE_STATUSES.includes(withdrawal.status)
              const isSelected = selectedIds.has(withdrawal.id)
              const validation = validatedNames[withdrawal.id]
              const isMoMo = withdrawal.withdrawal_method === "mobile_money"

              return (
                <Card
                  key={withdrawal.id}
                  className={`hover:shadow-lg transition-all relative ${isSelected ? "ring-2 ring-primary" : ""}`}
                >
                  {/* Selection checkbox */}
                  {canSelect && isSelectable && (
                    <div className="absolute top-4 left-4 z-10">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelection(withdrawal.id)}
                        className="w-4 h-4"
                      />
                    </div>
                  )}

                  <CardContent className={`pt-6 ${canSelect && isSelectable ? "pl-10" : ""}`}>
                    <div className="space-y-4">
                      {/* Header */}
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            {getStatusIcon(withdrawal.status)}
                            <h3 className="font-semibold text-lg truncate">
                              {withdrawal.user_shops?.shop_name || "Shop"}
                            </h3>
                            <Badge className={getStatusBadgeColor(withdrawal.status)}>
                              {withdrawal.status.toUpperCase()}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{withdrawal.reference_code}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            📅 {new Date(withdrawal.created_at).toLocaleString()}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-2xl font-bold text-foreground">GHS {(withdrawal.amount || 0).toFixed(2)}</p>
                          <p className="text-xs text-muted-foreground capitalize">{withdrawal.withdrawal_method}</p>
                          {withdrawal.fee_amount && withdrawal.fee_amount > 0 && (
                            <p className="text-xs text-warning font-medium mt-1">Fee: GHS {(withdrawal.fee_amount || 0).toFixed(2)}</p>
                          )}
                          {withdrawal.net_amount && (
                            <p className="text-xs text-success font-semibold mt-1">Payout: GHS {(withdrawal.net_amount || 0).toFixed(2)}</p>
                          )}
                          <div className="mt-2 pt-2 border-t border-border">
                            <p className="text-xs text-muted-foreground">Current Balance</p>
                            <p className={`text-sm font-bold ${
                              (withdrawal.current_available_balance ?? 0) >= withdrawal.amount
                                ? "text-success"
                                : "text-destructive"
                            }`}>
                              GHS {(withdrawal.current_available_balance ?? 0).toFixed(2)}
                              {(withdrawal.current_available_balance ?? 0) < withdrawal.amount && (
                                <span className="ml-1 text-xs">⚠️</span>
                              )}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Processing Details */}
                      <div className="border-t pt-4">
                        <p className="text-xs font-semibold text-foreground mb-3">Processing Details</p>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                          {/* Account Name + Moolre Validation */}
                          <div className="md:col-span-2">
                            <div className="flex items-center justify-between mb-1">
                              <p className="text-xs text-muted-foreground">Account Name</p>
                              {isMoMo && isSelectable && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-5 px-1.5 text-[10px] text-primary hover:bg-primary/10"
                                  disabled={validatingId === withdrawal.id}
                                  onClick={() => validateName(withdrawal)}
                                >
                                  {validatingId === withdrawal.id
                                    ? <><Loader2 className="w-2.5 h-2.5 animate-spin mr-1" />Validating...</>
                                    : validation ? "↺ Re-validate" : "Validate via Moolre"}
                                </Button>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 bg-primary/5 p-2 rounded border border-primary/20">
                                <p className="font-mono text-sm text-foreground">
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

                            {/* Validation result */}
                            {validation && (
                              <div className={`mt-2 px-2 py-1.5 rounded text-xs flex items-start gap-2 ${
                                validation.error
                                  ? "bg-warning/10 text-warning border border-warning/20"
                                  : validation.matched
                                  ? "bg-success/10 text-success border border-success/20"
                                  : "bg-destructive/10 text-destructive border border-destructive/20"
                              }`}>
                                {validation.error ? (
                                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                ) : validation.matched ? (
                                  <ShieldCheck className="w-3 h-3 mt-0.5 shrink-0" />
                                ) : (
                                  <ShieldX className="w-3 h-3 mt-0.5 shrink-0" />
                                )}
                                <span>
                                  {validation.error
                                    ? `Validation error: ${validation.error}`
                                    : validation.validatedName
                                    ? <>Moolre: <strong>{validation.validatedName}</strong>{!validation.matched && " — name mismatch"}</>
                                    : "Account not found on Moolre"}
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Mobile Money Number */}
                          {withdrawal.withdrawal_method === "mobile_money" && (
                            <>
                              <div>
                                <p className="text-xs text-muted-foreground mb-1">Mobile Number</p>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-success/10 p-2 rounded border border-border">
                                    <p className="font-mono text-sm">{withdrawal.account_details?.phone || "N/A"}</p>
                                  </div>
                                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(withdrawal.account_details?.phone || "", "Mobile Number")} className="h-8 w-8 p-0">
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground mb-1">Network</p>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-warning/10 p-2 rounded border border-border">
                                    <p className="font-mono text-sm font-semibold">{withdrawal.account_details?.network || "N/A"}</p>
                                  </div>
                                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(withdrawal.account_details?.network || "", "Network")} className="h-8 w-8 p-0">
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
                                <p className="text-xs text-muted-foreground mb-1">Bank Name</p>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-primary/10 p-2 rounded border border-border">
                                    <p className="font-mono text-sm">{withdrawal.account_details?.bank_name || "N/A"}</p>
                                  </div>
                                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(withdrawal.account_details?.bank_name || "", "Bank Name")} className="h-8 w-8 p-0">
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground mb-1">Account Number</p>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 bg-warning/10 p-2 rounded border border-border">
                                    <p className="font-mono text-sm">{withdrawal.account_details?.account_number || "N/A"}</p>
                                  </div>
                                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(withdrawal.account_details?.account_number || "", "Account Number")} className="h-8 w-8 p-0">
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
                            <p className="text-muted-foreground">Requested</p>
                            <p className="font-semibold">{new Date(withdrawal.created_at).toLocaleDateString()}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Updated</p>
                            <p className="font-semibold">{new Date(withdrawal.updated_at).toLocaleDateString()}</p>
                          </div>
                        </div>

                        {/* Moolre Transfer ID */}
                        {withdrawal.moolre_transfer_id && (
                          <div className="mb-3 bg-muted/40 p-2 rounded border border-border">
                            <p className="text-xs text-muted-foreground">Moolre Transfer ID</p>
                            <p className="font-mono text-xs">{withdrawal.moolre_transfer_id}</p>
                          </div>
                        )}

                        {/* Manual transfer notice */}
                        {withdrawal.status === "approved" && !withdrawal.moolre_transfer_id && (
                          <div className="mb-3 bg-warning/10 p-3 rounded border border-border">
                            <p className="text-xs text-warning font-medium">Manual transfer required — approved before Moolre integration.</p>
                          </div>
                        )}

                        {/* Processing notice + reset */}
                        {withdrawal.status === "processing" && (
                          <div className="mb-3 bg-primary/5 p-3 rounded border border-primary/20 space-y-2">
                            <div className="flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                              <p className="text-xs text-primary">Transfer in progress — awaiting MoMo confirmation.</p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={actionLoadingId === withdrawal.id}
                              onClick={() => resetProcessing(withdrawal.id)}
                              className="w-full text-xs border-border text-warning hover:bg-warning/10"
                            >
                              {actionLoadingId === withdrawal.id
                                ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Resetting...</>
                                : "↺ Reset to Pending (stuck transfer)"}
                            </Button>
                          </div>
                        )}

                        {/* Failed notice */}
                        {withdrawal.status === "failed" && (
                          <div className="mb-3 bg-destructive/10 p-3 rounded border border-border">
                            <p className="text-xs text-destructive font-medium">Transfer failed. Funds were NOT sent.</p>
                          </div>
                        )}

                        {/* Single-item action buttons */}
                        {(withdrawal.status === "pending" || withdrawal.status === "failed") && (
                          <div className="space-y-2">
                            {(withdrawal.withdrawal_method === "mobile_money" || (withdrawal.withdrawal_method === "bank_transfer" && (withdrawal.account_details as any)?.sublistid)) && withdrawal.net_amount && withdrawal.net_amount !== withdrawal.amount && (
                              <p className="text-xs text-muted-foreground text-center">
                                Moolre will send <span className="font-semibold">GHS {withdrawal.net_amount.toFixed(2)}</span> (after GHS {(withdrawal.fee_amount ?? 0).toFixed(2)} fee)
                              </p>
                            )}
                            {(withdrawal.withdrawal_method === "mobile_money" || (withdrawal.withdrawal_method === "bank_transfer" && (withdrawal.account_details as any)?.sublistid)) && (
                              <Button
                                onClick={() => approveWithdrawal(withdrawal.id)}
                                disabled={actionLoadingId === withdrawal.id}
                                className="w-full bg-success hover:bg-success/90 text-primary-foreground text-sm"
                              >
                                {actionLoadingId === withdrawal.id
                                  ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Processing...</>
                                  : withdrawal.status === "failed" ? "↺ Retry Transfer (Auto)" : "✓ Approve & Transfer (Auto)"}
                              </Button>
                            )}
                            <div className="flex gap-2">
                              <Button
                                onClick={() => approveWithdrawal(withdrawal.id, true)}
                                disabled={actionLoadingId === withdrawal.id}
                                variant="outline"
                                className="flex-1 text-sm border-border text-primary hover:bg-primary/5"
                              >
                                {actionLoadingId === withdrawal.id
                                  ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Processing...</>
                                  : withdrawal.status === "failed" ? "↺ Retry (Manual)" : "✓ Manual Approve"}
                              </Button>
                              <Button
                                onClick={() => { setSelectedWithdrawal(withdrawal); setRejectionReason("") }}
                                variant="outline"
                                disabled={actionLoadingId === withdrawal.id}
                                className="flex-1 text-sm border-border text-destructive hover:bg-destructive/10"
                              >
                                ✕ Reject
                              </Button>
                            </div>
                          </div>
                        )}

                        {withdrawal.status === "rejected" && withdrawal.rejection_reason && (
                          <div className="bg-destructive/10 p-3 rounded border border-border">
                            <p className="text-xs font-semibold text-destructive mb-1">Rejection Reason</p>
                            <p className="text-sm text-destructive">{withdrawal.rejection_reason}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}

        {/* Rejection Reason Modal */}
        {selectedWithdrawal && selectedWithdrawal.status === "pending" && (
          <Card className="border-2 border-border fixed inset-0 m-auto max-w-md max-h-96 z-50">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Reject Withdrawal</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => { setSelectedWithdrawal(null); setRejectionReason("") }}>✕</Button>
              </div>
              <CardDescription>
                {selectedWithdrawal.user_shops?.shop_name} — GHS {selectedWithdrawal.amount.toFixed(2)}
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
                  disabled={actionLoadingId === selectedWithdrawal.id || !rejectionReason.trim()}
                  className="flex-1 bg-destructive hover:bg-destructive/90 text-primary-foreground"
                >
                  {actionLoadingId === selectedWithdrawal.id
                    ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Processing...</>
                    : "✕ Reject"}
                </Button>
                <Button onClick={() => { setSelectedWithdrawal(null); setRejectionReason("") }} variant="outline" className="flex-1">
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Bulk Results Dialog */}
        <Dialog open={!!bulkResults} onOpenChange={(open) => { if (!open) setBulkResults(null) }}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Batch Approval Results</DialogTitle>
            </DialogHeader>
            {bulkResults && (
              <div className="space-y-3">
                <div className="flex gap-4 text-sm">
                  <span className="text-success font-semibold">✓ {bulkResults.filter(r => r.success).length} succeeded</span>
                  <span className="text-destructive font-semibold">✗ {bulkResults.filter(r => !r.success).length} failed</span>
                </div>
                <div className="space-y-2">
                  {bulkResults.map((r) => (
                    <div
                      key={r.id}
                      className={`p-3 rounded-lg text-xs border ${r.success ? "bg-success/5 border-success/20" : "bg-destructive/5 border-destructive/20"}`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold">{r.shopName}</span>
                        <div className="flex items-center gap-2">
                          <span className="font-mono">GHS {r.amount.toFixed(2)}</span>
                          <Badge className={r.success ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}>
                            {r.status}
                          </Badge>
                        </div>
                      </div>
                      <p className="text-muted-foreground">{r.message}</p>
                    </div>
                  ))}
                </div>
                <Button onClick={() => setBulkResults(null)} className="w-full" variant="outline">Close</Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
