"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { useUserRole } from "@/hooks/use-user-role"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Wallet, Plus, Minus, TrendingUp, TrendingDown, AlertCircle, Loader2, RefreshCw, CheckCircle } from "lucide-react"
import { WalletTopUp } from "@/components/wallet-top-up"
import { SuccessModal } from "@/components/success-modal"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

interface WalletData {
  balance: number
  totalCredited: number
  totalDebited: number
  transactionCount: number
}

interface Transaction {
  id: string
  created_at: string
  type: string
  amount: number
  description: string
  reference: string
}

interface PendingPayment {
  id: string
  reference: string
  amount: number
  created_at: string
  status: string
}

export default function WalletPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, loading: authLoading } = useAuth()
  const { isDealer } = useUserRole()
  const [userId, setUserId] = useState<string | null>(null)
  const [walletData, setWalletData] = useState<WalletData>({
    balance: 0,
    totalCredited: 0,
    totalDebited: 0,
    transactionCount: 0,
  })
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [pendingPayments, setPendingPayments] = useState<PendingPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [showTopUp, setShowTopUp] = useState(false)
  const [paymentVerifying, setPaymentVerifying] = useState(false)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [successModal, setSuccessModal] = useState<{
    open: boolean
    title: string
    message: string
    details: Array<{ label: string; value: string }>
  }>({ open: false, title: "", message: "", details: [] })

  // Feature Toggle State
  const [walletTopupsEnabled, setWalletTopupsEnabled] = useState<boolean>(true)

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[WALLET] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  // Proactively refresh JWT on wallet page load so top-up calls don't get
  // blocked by an expired token (initialize endpoint returns 401 if user_id
  // cannot be extracted from a stale JWT).
  useEffect(() => {
    supabase.auth.refreshSession().catch(() => {
      // Refresh failure means the session is truly expired — the auth state
      // change listener in use-auth.ts will handle the redirect to login.
    })
  }, [])

  useEffect(() => {
    if (user) {
      fetchUserAndWallet()

      // Check if returning from Paystack payment
      const reference = searchParams.get("reference")
      if (reference) {
        console.log("[WALLET] Payment reference detected:", reference)
        verifyPaymentAndRefresh(reference)
      }

      // Fetch public toggles
      fetch("/api/settings/public")
        .then((res) => res.json())
        .then((data) => {
          if (data.wallet_topups_enabled !== undefined) {
            setWalletTopupsEnabled(data.wallet_topups_enabled)
          }
        })
        .catch((err) => console.error("Failed to load toggles", err))
    }
  }, [user])

  const fetchUserAndWallet = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push("/auth/login")
        return
      }

      setUserId(user.id)
      await Promise.all([
        fetchWalletData(user.id),
        fetchTransactions(user.id),
        fetchPendingPayments(user.id),
      ])
    } catch (error) {
      console.error("Error fetching user:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load wallet data"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const fetchWalletData = async (userId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No session token")

      const response = await fetch("/api/wallet/balance", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })

      // If wallet not found (no wallet row exists), create one
      if (response.status === 404) {
        console.log("[WALLET] Wallet not found, creating new wallet via API")
        try {
          const createResponse = await fetch("/api/wallet/create", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${session.access_token}`,
            },
          })

          if (createResponse.ok) {
            const result = await createResponse.json()
            console.log("[WALLET] Wallet created:", result.wallet)
            setWalletData({
              balance: result.wallet.balance || 0,
              totalCredited: result.wallet.totalCredited || 0,
              totalDebited: result.wallet.totalDebited || 0,
              transactionCount: 0,
            })
            return
          }
        } catch (createError) {
          console.error("[WALLET] Error creating wallet:", createError)
          // Fall through to default values
          setWalletData({
            balance: 0,
            totalCredited: 0,
            totalDebited: 0,
            transactionCount: 0,
          })
          return
        }
      }

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to fetch wallet")
      }

      const data = await response.json()
      setWalletData(data)
    } catch (error) {
      console.error("Error fetching wallet data:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load wallet balance"
      toast.error(errorMessage)
    }
  }

  const fetchTransactions = async (userId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("No session token")

      const response = await fetch("/api/wallet/transactions?limit=10", {
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
        },
      })
      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to fetch transactions")
      }

      const data = await response.json()
      setTransactions(data.transactions || [])
    } catch (error) {
      console.error("Error fetching transactions:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load transaction history"
      toast.error(errorMessage)
    }
  }

  const fetchPendingPayments = async (uid: string) => {
    try {
      // Fetch pending wallet payments from the last 24 hours
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { data, error } = await supabase
        .from("wallet_payments")
        .select("id, reference, amount, created_at, status")
        .eq("user_id", uid)
        .in("status", ["pending", "abandoned"])
        .gte("created_at", twentyFourHoursAgo)
        .order("created_at", { ascending: false })
        .limit(10)

      if (!error && data) {
        setPendingPayments(data)
      }
    } catch (err) {
      console.error("[WALLET] Error fetching pending payments:", err)
    }
  }

  const verifyPendingPayment = async (payment: PendingPayment) => {
    setVerifyingId(payment.id)
    try {
      const response = await fetch("/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: payment.reference }),
      })
      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || "Verification failed")
      }

      if (result.status === "success" || result.status === "completed") {
        toast.success("Payment verified! Your wallet has been credited.")
        // Remove from pending list
        setPendingPayments(prev => prev.filter(p => p.id !== payment.id))
      } else if (result.status === "failed" || result.status === "abandoned") {
        toast.error(`Payment ${result.status}. This payment was not completed on Paystack.`)
        setPendingPayments(prev => prev.filter(p => p.id !== payment.id))
      } else {
        toast.info("Payment is still processing. Please try again in a few minutes.")
      }

      // Refresh wallet data
      if (userId) {
        await Promise.all([
          fetchWalletData(userId),
          fetchTransactions(userId),
        ])
      }
    } catch (error) {
      console.error("[WALLET] Error verifying payment:", error)
      toast.error(error instanceof Error ? error.message : "Failed to verify payment")
    } finally {
      setVerifyingId(null)
    }
  }

  const verifyPaymentAndRefresh = async (reference: string) => {
    try {
      setPaymentVerifying(true)
      console.log("[WALLET] Verifying payment:", reference)

      // Clear reference from URL immediately to prevent double verification on reload
      window.history.replaceState({}, "", "/dashboard/wallet")

      // Call verification endpoint
      const response = await fetch("/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reference }),
      })

      const result = await response.json()

      if (!response.ok) {
        console.error("[WALLET] Verification failed:", result)
        toast.error("Payment verification failed. Please try again.")
        return
      }

      console.log("[WALLET] Payment verified successfully")
      toast.success("Payment verified! Your wallet will be updated shortly.")

      // Show success modal
      setSuccessModal({
        open: true,
        title: "Top-Up Successful!",
        message: "Your payment has been verified and your wallet has been credited.",
        details: [
          { label: "Reference", value: reference.slice(-10) },
        ],
      })

      // Refresh wallet data
      if (userId) {
        await Promise.all([
          fetchWalletData(userId),
          fetchTransactions(userId),
          fetchPendingPayments(userId),
        ])
      }
    } catch (error) {
      console.error("[WALLET] Error verifying payment:", error)
      toast.error("Failed to verify payment")
    } finally {
      setPaymentVerifying(false)
    }
  }

  const handleTopUpSuccess = async (amount: number) => {
    console.log("[WALLET-PAGE] Top up successful, amount:", amount)
    setShowTopUp(false)

    // Show success modal
    setSuccessModal({
      open: true,
      title: "Top-Up Successful!",
      message: "Your wallet has been credited successfully.",
      details: [
        { label: "Amount", value: `GHS ${amount.toFixed(2)}` },
      ],
    })

    if (userId) {
      console.log("[WALLET-PAGE] Refetching wallet data and transactions...")
      // Wait a bit more to ensure data is written
      await new Promise(resolve => setTimeout(resolve, 500))
      await Promise.all([
        fetchWalletData(userId),
        fetchTransactions(userId),
        fetchPendingPayments(userId),
      ])
      console.log("[WALLET-PAGE] Wallet data refreshed")
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      </DashboardLayout>
    )
  }
  return (
    <DashboardLayout>
      <div className="space-y-6 px-2 sm:px-4">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Wallet</h1>
          <p className="text-gray-600 mt-1 text-sm sm:text-base">Manage your account balance and funds</p>
        </div>

        {/* Balance Card */}
        <Card className={`text-white border-0 ${isDealer
          ? "bg-gradient-to-r from-amber-500 via-orange-500 to-yellow-500"
          : "bg-gradient-to-r from-blue-600 to-purple-600"
          }`}>
          <CardHeader>
            <CardTitle className="text-white">Current Balance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className={`${isDealer ? "text-amber-100" : "text-blue-100"} text-sm`}>Available Balance</p>
                <p className="text-2xl sm:text-3xl md:text-4xl font-bold">GHS {Math.max(0, walletData.balance).toFixed(2)}</p>
              </div>
              <Wallet className={`w-16 h-16 opacity-50 ${isDealer ? "text-amber-100" : "text-blue-100"}`} />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
              {walletTopupsEnabled || isDealer ? (
                <Button
                  onClick={() => setShowTopUp(!showTopUp)}
                  className={`bg-white hover:bg-gray-100 w-full sm:w-auto ${isDealer ? "text-amber-600" : "text-blue-600"
                    }`}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Funds
                </Button>
              ) : (
                <div className="bg-white/10 backdrop-blur-sm border border-white/20 rounded-lg p-3 w-full text-sm text-white/90">
                  ⚠️ Wallet top-ups are currently temporarily disabled for maintenance.
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Top Up Form */}
        {(showTopUp && (walletTopupsEnabled || isDealer)) && (
          <div className="animate-in fade-in slide-in-from-top-2">
            <WalletTopUp onSuccess={handleTopUpSuccess} />
          </div>
        )}

        {/* Pending Payments Alert */}
        {pendingPayments.length > 0 && (
          <Card className="border-yellow-300 bg-yellow-50">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2 text-yellow-800">
                <AlertCircle className="w-5 h-5" />
                Pending Payments ({pendingPayments.length})
              </CardTitle>
              <CardDescription className="text-yellow-700">
                These payments are still processing. If you completed payment on Paystack, click &quot;Verify&quot; to credit your wallet.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingPayments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3 rounded-lg bg-white border border-yellow-200"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900">
                        GHS {(payment.amount || 0).toFixed(2)}
                      </span>
                      <Badge className="bg-yellow-100 text-yellow-800 text-xs">
                        {payment.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {new Date(payment.created_at).toLocaleString()} · Ref: {payment.reference?.slice(-10) || "—"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => verifyPendingPayment(payment)}
                    disabled={verifyingId === payment.id}
                    className="bg-yellow-600 hover:bg-yellow-700 text-white w-full sm:w-auto"
                  >
                    {verifyingId === payment.id ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <CheckCircle className="w-4 h-4 mr-2" />
                    )}
                    Verify Payment
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 lg:gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Credited</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {walletData.totalCredited.toFixed(2)}</div>
              <p className="text-xs text-gray-600">All deposits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Spent</CardTitle>
              <TrendingDown className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {walletData.totalDebited.toFixed(2)}</div>
              <p className="text-xs text-gray-600">All purchases</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Available Balance</CardTitle>
              <Wallet className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">GHS {Math.max(0, walletData.balance).toFixed(2)}</div>
              <p className="text-xs text-gray-600">Ready to use</p>
            </CardContent>
          </Card>
        </div>

        {/* Transaction History */}
        <Card>
          <CardHeader>
            <CardTitle>Transaction History</CardTitle>
            <CardDescription>
              {transactions.length === 0 ? "No transactions yet" : `Your recent ${transactions.length} transactions`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {transactions.length === 0 ? (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>No transactions found. Start by adding funds to your wallet.</AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="overflow-x-auto rounded-md border border-gray-100">
                  <table className="min-w-[600px] w-full text-xs sm:text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Date</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Description</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Amount</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Type</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-900">Reference</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {transactions.map((transaction) => (
                        <tr key={transaction.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3">
                            {new Date(transaction.created_at).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-3">{transaction.description}</td>
                          <td className={`px-4 py-3 font-semibold ${transaction.type.includes("credit") ? "text-green-600" : "text-red-600"
                            }`}>
                            {transaction.type.includes("credit") ? "+" : "-"}GHS {(transaction.amount || 0).toFixed(2)}
                          </td>
                          <td className="px-4 py-3">
                            <Badge className={
                              transaction.type.includes("credit")
                                ? "bg-green-100 text-green-800"
                                : "bg-red-100 text-red-800"
                            }>
                              {transaction.type.charAt(0).toUpperCase() + transaction.type.slice(1)}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 font-mono text-gray-600">
                            {transaction.reference?.slice(-8) || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex justify-between items-center">
                  <p className="text-sm text-gray-600">Showing {transactions.length} transaction(s)</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Success Modal */}
      <SuccessModal
        open={successModal.open}
        onClose={() => setSuccessModal(prev => ({ ...prev, open: false }))}
        title={successModal.title}
        message={successModal.message}
        details={successModal.details}
      />
    </DashboardLayout>
  )
}