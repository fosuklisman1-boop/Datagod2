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
import { Wallet, Plus, TrendingUp, TrendingDown, AlertCircle, Loader2, CheckCircle, LayoutGrid, Wifi, GraduationCap, Phone, IdCard, MoreHorizontal } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
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
  source?: string
}

// Real `source` column on the `transactions` table (already filtered on in
// app/api/admin/transactions/route.ts) bucketed into the categories the
// customer-facing history is split into. Anything unrecognized -- admin
// operations, debt recovery, whitelist checks, null sources, etc -- falls
// into "misc" rather than being silently dropped.
type TxCategory = "topup" | "data" | "results" | "airtime" | "afa" | "misc"

function categorizeTransaction(source?: string | null): TxCategory {
  const s = (source || "").toLowerCase()
  if (s.includes("topup") || s.includes("top_up")) return "topup"
  if (s.includes("results_check")) return "results"
  if (s.includes("airtime")) return "airtime"
  if (s.includes("afa")) return "afa"
  if (s.includes("data") || s.includes("bulk_order")) return "data"
  return "misc"
}

interface PendingPayment {
  id: string
  reference: string
  amount: number
  created_at: string
  status: string
}

const TABS = [
  { id: "stats", label: "Stats", icon: LayoutGrid },
  { id: "topup", label: "Top Ups", icon: Plus },
  { id: "data", label: "Data", icon: Wifi },
  { id: "results", label: "Results Checker", icon: GraduationCap },
  { id: "airtime", label: "Airtime", icon: Phone },
  { id: "afa", label: "AFA", icon: IdCard },
  { id: "misc", label: "Misc", icon: MoreHorizontal },
] as const

type TabId = (typeof TABS)[number]["id"]

function TransactionList({ transactions, emptyMessage }: { transactions: Transaction[]; emptyMessage: string }) {
  if (transactions.length === 0) {
    return (
      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{emptyMessage}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-2">
      {transactions.map((transaction) => {
        const credit = transaction.type.includes("credit")
        return (
          <div key={transaction.id} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl ${credit ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                {credit ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{transaction.description}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(transaction.created_at).toLocaleDateString()} · {transaction.reference?.slice(-8) || "—"}
                </p>
              </div>
            </div>
            <p className={`whitespace-nowrap font-semibold tabular-nums ${credit ? "text-success" : "text-destructive"}`}>
              {credit ? "+" : "-"}GHS {(transaction.amount || 0).toFixed(2)}
            </p>
          </div>
        )
      })}
    </div>
  )
}

export default function WalletPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, loading: authLoading } = useAuth()
  const { isDealer } = useUserRole()
  const [tab, setTab] = useState<TabId>("stats")
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

      // Fetch a larger window than the old flat history list needed --
      // splitting into category tabs means each one only shows a slice of
      // this set, so a 10-row page would starve most categories.
      const response = await fetch("/api/wallet/transactions?limit=200", {
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
    setTab("stats")

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
        <div className="space-y-6 px-2 sm:px-4">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-40 w-full rounded-2xl" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </DashboardLayout>
    )
  }
  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-5">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Wallet</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage your account balance and funds</p>
        </div>

        {/* Tabs -- 7 categories don't fit an equal-width pill row, so this
            scrolls horizontally instead of wrapping or shrinking text. */}
        <div className="-mx-2 overflow-x-auto px-2 sm:mx-0 sm:px-0">
          <div className="inline-flex min-w-full gap-1 rounded-2xl bg-muted p-1 sm:min-w-0">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-bold transition ${
                  tab === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>
        </div>

        {tab === "stats" && (
        <>
        {/* Balance hero -- same navy-gradient language as the rest of this
            rebuild (dashboard banner, etc.), dealer keeps its own amber
            identity like everywhere else in this app. */}
        <div className={`rounded-2xl p-5 text-white ${isDealer ? "bg-warning" : "bg-gradient-to-br from-[#1b388b] to-[#2a5ce8]"}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className={`text-sm ${isDealer ? "text-amber-100" : "text-white/70"}`}>Available Balance</p>
              <p className="mt-1 text-3xl font-black">GHS {Math.max(0, walletData.balance).toFixed(2)}</p>
            </div>
            <Wallet className={`h-12 w-12 opacity-40 ${isDealer ? "text-amber-100" : "text-white"}`} />
          </div>
          <div className="mt-4">
            {walletTopupsEnabled || isDealer ? (
              <button
                onClick={() => setTab("topup")}
                className={`flex items-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-sm font-bold hover:bg-white/90 ${isDealer ? "text-amber-600" : "text-[#1b388b]"}`}
              >
                <Plus className="h-4 w-4" /> Add Funds
              </button>
            ) : (
              <div className="rounded-2xl border border-white/20 bg-white/10 p-3 text-sm text-white/90 backdrop-blur-sm">
                ⚠️ Wallet top-ups are currently temporarily disabled for maintenance.
              </div>
            )}
          </div>
        </div>

        {/* Pending Payments Alert */}
        {pendingPayments.length > 0 && (
          <Card className="border-warning/40 bg-warning/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2 text-warning">
                <AlertCircle className="w-5 h-5" />
                Pending Payments ({pendingPayments.length})
              </CardTitle>
              <CardDescription>
                These payments are still processing. If you completed payment on Paystack, click &quot;Verify&quot; to credit your wallet.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingPayments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-2xl border border-warning/30 bg-card p-3"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground">
                        GHS {(payment.amount || 0).toFixed(2)}
                      </span>
                      <Badge className="bg-warning/15 text-warning text-xs">
                        {payment.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(payment.created_at).toLocaleString()} · Ref: {payment.reference?.slice(-10) || "—"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => verifyPendingPayment(payment)}
                    disabled={verifyingId === payment.id}
                    className="w-full rounded-full bg-warning text-warning-foreground hover:bg-warning/90 sm:w-auto"
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

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-success/10 text-success">
              <TrendingUp className="h-4 w-4" />
            </span>
            <p className="mt-2 text-lg font-black text-foreground">GHS {walletData.totalCredited.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">Total Credited</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <TrendingDown className="h-4 w-4" />
            </span>
            <p className="mt-2 text-lg font-black text-foreground">GHS {walletData.totalDebited.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">Total Spent</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Wallet className="h-4 w-4" />
            </span>
            <p className="mt-2 text-lg font-black text-foreground">GHS {Math.max(0, walletData.balance).toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">Available</p>
          </div>
        </div>
        </>
        )}

        {tab === "topup" && (
          <div className="space-y-5">
            {walletTopupsEnabled || isDealer ? (
              <WalletTopUp onSuccess={handleTopUpSuccess} />
            ) : (
              <div className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
                ⚠️ Wallet top-ups are currently temporarily disabled for maintenance.
              </div>
            )}
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Top-up history</p>
              <TransactionList
                transactions={transactions.filter((t) => categorizeTransaction(t.source) === "topup")}
                emptyMessage="No top-ups yet."
              />
            </div>
          </div>
        )}

        {tab === "data" && (
          <TransactionList
            transactions={transactions.filter((t) => categorizeTransaction(t.source) === "data")}
            emptyMessage="No data purchase transactions found."
          />
        )}

        {tab === "results" && (
          <TransactionList
            transactions={transactions.filter((t) => categorizeTransaction(t.source) === "results")}
            emptyMessage="No results checker/checking transactions found."
          />
        )}

        {tab === "airtime" && (
          <TransactionList
            transactions={transactions.filter((t) => categorizeTransaction(t.source) === "airtime")}
            emptyMessage="No airtime transactions found."
          />
        )}

        {tab === "afa" && (
          <TransactionList
            transactions={transactions.filter((t) => categorizeTransaction(t.source) === "afa")}
            emptyMessage="No AFA registration transactions found."
          />
        )}

        {tab === "misc" && (
          <TransactionList
            transactions={transactions.filter((t) => categorizeTransaction(t.source) === "misc")}
            emptyMessage="No miscellaneous transactions found."
          />
        )}
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