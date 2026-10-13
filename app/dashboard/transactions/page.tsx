"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Loader2,
  AlertCircle,
  LayoutGrid,
  Plus,
  Wifi,
  GraduationCap,
  Phone,
  IdCard,
  MoreHorizontal,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

const formatAmount = (amount: number | null | undefined): string => {
  if (amount == null) return "0.00"
  return amount.toFixed(2)
}

interface TransactionStats {
  totalTransactions: number
  todayIncome: number
  todayExpenses: number
}

interface Transaction {
  id: string
  created_at: string
  type: string
  description: string
  amount: number
  status: string
  source?: string
  reference_id?: string
}

// Real `source` column on the `transactions` table, bucketed into the
// categories this page is split into. `type` is "credit" | "debit" |
// "admin_credit" | "admin_debit" in the real data -- there is no "refund"
// type, so credit/debit is detected with .includes() rather than an exact
// match (an exact match mis-signs every admin_credit/admin_debit row).
type TxCategory = "topup" | "data" | "results" | "airtime" | "afa" | "misc"

function isCredit(type: string): boolean {
  return type.includes("credit")
}

function categorizeTransaction(source?: string | null): TxCategory {
  const s = (source || "").toLowerCase()
  if (s === "wallet_topup") return "topup"
  if (s.includes("results_check")) return "results"
  if (s.includes("airtime")) return "airtime"
  if (s.includes("afa")) return "afa"
  if (s === "data_purchase" || s === "api_order" || s === "bulk_order" || s.includes("data")) return "data"
  return "misc"
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
    <div className="space-y-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
      {transactions.map((transaction) => {
        const credit = isCredit(transaction.type)
        return (
          <div key={transaction.id} className="flex items-center justify-between gap-3 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
            <div className="flex min-w-0 items-center gap-3">
              <span className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl ${credit ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                {credit ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{transaction.description}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(transaction.created_at).toLocaleDateString()} · {transaction.reference_id?.slice(-8) || "—"}
                  {transaction.status === "pending" && <span className="ml-1 text-warning">· Pending</span>}
                </p>
              </div>
            </div>
            <p className={`whitespace-nowrap font-semibold tabular-nums ${credit ? "text-success" : "text-destructive"}`}>
              {credit ? "+" : "-"}GHS {formatAmount(transaction.amount)}
            </p>
          </div>
        )
      })}
    </div>
  )
}

export default function TransactionsPage() {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [tab, setTab] = useState<TabId>("stats")
  const [stats, setStats] = useState<TransactionStats>({
    totalTransactions: 0,
    todayIncome: 0,
    todayExpenses: 0,
  })
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)

  // Auth protection
  useEffect(() => {
    if (!authLoading && !user) {
      console.log("[TRANSACTIONS] User not authenticated, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      fetchTransactionData()
    }
  }, [user])

  const fetchTransactionData = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const statsResponse = await fetch("/api/transactions/stats", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (statsResponse.ok) {
        const statsData = await statsResponse.json()
        setStats(statsData)
      }

      // Fetch a larger window than the old 10-row page needed -- splitting
      // into category tabs means each one only shows a slice of this set.
      const txnResponse = await fetch(`/api/transactions/list?limit=200`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (txnResponse.ok) {
        const txnData = await txnResponse.json()
        setTransactions(txnData.transactions || [])
      }
    } catch (error) {
      console.error("Error fetching transaction data:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to load transaction data"
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-2xl lg:max-w-4xl mx-auto space-y-5">
        <DashboardHeroBanner title="Transactions" subtitle="Track and manage your financial activities" icon={DollarSign} />

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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
            <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1b388b]/10 text-[#1b388b]">
                <DollarSign className="h-4 w-4" />
              </span>
              <p className="mt-2 text-lg font-black text-foreground">{stats.totalTransactions.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Total Transactions</p>
            </div>
            <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-success/10 text-success">
                <TrendingUp className="h-4 w-4" />
              </span>
              <p className="mt-2 text-lg font-black text-foreground">GHS {formatAmount(stats.todayIncome)}</p>
              <p className="text-xs text-muted-foreground">Today&apos;s Income</p>
            </div>
            <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                <TrendingDown className="h-4 w-4" />
              </span>
              <p className="mt-2 text-lg font-black text-foreground">GHS {formatAmount(stats.todayExpenses)}</p>
              <p className="text-xs text-muted-foreground">Today&apos;s Expenses</p>
            </div>
          </div>
        )}

        {tab === "topup" && (
          <TransactionList
            transactions={transactions.filter((t) => categorizeTransaction(t.source) === "topup")}
            emptyMessage="No top-ups yet."
          />
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
    </DashboardLayout>
  )
}
