"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { shopService, shopProfitService } from "@/lib/shop-service"
import { supabase } from "@/lib/supabase"
import { ArrowLeft, Activity, RefreshCw, Wallet, TrendingUp, TrendingDown, Scale, MessageSquare, BarChart3 } from "lucide-react"
import { toast } from "sonner"

type DateRange = "today" | "7d" | "30d" | "all"
type Category = "all" | "earnings" | "withdrawals" | "expenses"
type LedgerType = "earning" | "withdrawal" | "expense"

interface LedgerEntry {
  id: string
  type: LedgerType
  amount: number
  description: string
  created_at: string
}

const DATE_RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 Days" },
  { id: "30d", label: "30 Days" },
  { id: "all", label: "All Time" },
] as const

const CATEGORY_TABS = [
  { id: "all", label: "All" },
  { id: "earnings", label: "Earnings" },
  { id: "withdrawals", label: "Withdrawals" },
  { id: "expenses", label: "Expenses" },
] as const

function isWithinRange(dateStr: string, range: DateRange): boolean {
  if (range === "all") return true
  const d = new Date(dateStr).getTime()
  const now = Date.now()
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30
  const start = range === "today" ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : now - days * 24 * 60 * 60 * 1000
  return d >= start
}

export default function ShopProfitLogsPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [balance, setBalance] = useState<{ available_balance: number; total_profit: number; withdrawn_profit: number } | null>(null)
  const [entries, setEntries] = useState<LedgerEntry[]>([])

  const [dateRange, setDateRange] = useState<DateRange>("30d")
  const [category, setCategory] = useState<Category>("all")

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    try {
      setLoading(true)
      if (!user?.id) return
      const userShop = await shopService.getShop(user.id)
      setShop(userShop)
      if (!userShop) return

      const [balanceData, profitHistory, withdrawalsRes, expensesRes] = await Promise.all([
        shopProfitService.getShopBalanceFromTable(userShop.id).catch(() => null),
        shopProfitService.getProfitHistory(userShop.id).catch(() => []),
        supabase.from("withdrawal_requests").select("id, amount, net_amount, fee_amount, status, reference_code, created_at").eq("shop_id", userShop.id).order("created_at", { ascending: false }),
        // Real, checkable shop-owner expenses -- confirmed these are the ONLY
        // sources actually written to `transactions` for a shop's SMS/USSD
        // spend. SMS bundle-credit purchases live in sms_unit_transactions
        // (units, not GHS, no price-at-purchase stored) so they can't be
        // honestly included here -- see commit message.
        supabase.from("transactions").select("id, amount, description, source, created_at").eq("user_id", user.id).in("source", ["ussd_shop_activation", "whatsapp_shop_activation"]).order("created_at", { ascending: false }),
      ])

      setBalance(balanceData)

      const earningEntries: LedgerEntry[] = (profitHistory || []).map((p: any) => ({
        id: `earning-${p.id}`,
        type: "earning",
        amount: Number(p.profit_amount ?? p.amount ?? 0),
        description: p.shop_orders ? `${p.shop_orders.network} ${p.shop_orders.volume_gb}GB — ${p.shop_orders.customer_name || "Customer"}` : (p.profit_type || "Order profit"),
        created_at: p.created_at,
      }))

      const withdrawalEntries: LedgerEntry[] = (withdrawalsRes.data || []).map((w: any) => ({
        id: `withdrawal-${w.id}`,
        type: "withdrawal",
        amount: Number(w.net_amount ?? w.amount ?? 0),
        description: `Withdrawal ${w.reference_code || ""} — ${w.status}`,
        created_at: w.created_at,
      }))

      const expenseEntries: LedgerEntry[] = (expensesRes.data || []).map((t: any) => ({
        id: `expense-${t.id}`,
        type: "expense",
        amount: Number(t.amount ?? 0),
        description: t.description || t.source,
        created_at: t.created_at,
      }))

      const all = [...earningEntries, ...withdrawalEntries, ...expenseEntries].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
      setEntries(all)
    } catch (error) {
      console.error("Error loading profit logs:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load profit logs")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const handleRefresh = () => { setRefreshing(true); loadData() }

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (!isWithinRange(e.created_at, dateRange)) return false
      if (category === "earnings" && e.type !== "earning") return false
      if (category === "withdrawals" && e.type !== "withdrawal") return false
      if (category === "expenses" && e.type !== "expense") return false
      return true
    })
  }, [entries, dateRange, category])

  const periodStats = useMemo(() => {
    const inPeriod = entries.filter((e) => isWithinRange(e.created_at, dateRange))
    const earned = inPeriod.filter((e) => e.type === "earning").reduce((s, e) => s + e.amount, 0)
    const withdrawn = inPeriod.filter((e) => e.type === "withdrawal").reduce((s, e) => s + e.amount, 0)
    const expenses = inPeriod.filter((e) => e.type === "expense").reduce((s, e) => s + e.amount, 0)
    return { earned, withdrawn, net: earned - expenses, expenses }
  }, [entries, dateRange])

  const typeMeta: Record<LedgerType, { icon: any; className: string; sign: string }> = {
    earning: { icon: TrendingUp, className: "bg-success/10 text-success", sign: "+" },
    withdrawal: { icon: TrendingDown, className: "bg-[#1b388b]/10 text-[#1b388b]", sign: "-" },
    expense: { icon: MessageSquare, className: "bg-destructive/10 text-destructive", sign: "-" },
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <RefreshCw className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/dashboard/my-shop" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-5 w-5" /></Link>
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground"><BarChart3 className="h-5 w-5 text-[#1b388b]" /> Profit Logs</h1>
              <p className="text-sm text-muted-foreground">Full ledger — every earning, withdrawal and expense with running balance.</p>
            </div>
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-accent"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>

        {/* Profit balance hero */}
        <div className="rounded-2xl bg-gradient-to-br from-success/10 to-success/5 border border-success/20 p-5">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-success"><Wallet className="h-3.5 w-3.5" /> Profit Balance</p>
          <p className="mt-1 text-3xl font-black text-foreground">GH₵{(balance?.available_balance || 0).toFixed(2)}</p>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>Lifetime earned</span>
            <span className="font-semibold text-foreground">GH₵{(balance?.total_profit || 0).toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Lifetime withdrawn</span>
            <span className="font-semibold text-foreground">GH₵{(balance?.withdrawn_profit || 0).toFixed(2)}</span>
          </div>
        </div>

        {/* Period stats */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5 text-success" /> Earned</p>
            <p className="mt-1 text-lg font-black text-success">GH₵{periodStats.earned.toFixed(2)}</p>
            <p className="text-[10px] text-muted-foreground">this period</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><TrendingDown className="h-3.5 w-3.5 text-[#1b388b]" /> Withdrawn</p>
            <p className="mt-1 text-lg font-black text-[#1b388b]">GH₵{periodStats.withdrawn.toFixed(2)}</p>
            <p className="text-[10px] text-muted-foreground">this period</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Scale className="h-3.5 w-3.5" /> Net</p>
            <p className="mt-1 text-lg font-black text-foreground">{periodStats.net >= 0 ? "+" : ""}GH₵{periodStats.net.toFixed(2)}</p>
            <p className="text-[10px] text-muted-foreground">earned − expenses</p>
          </div>
        </div>

        {/* Expenses summary -- real: USSD/WhatsApp shop activation fees only.
            SMS bundle-credit purchases live in sms_unit_transactions (units,
            no GHS amount stored per row) and can't be honestly summed here. */}
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4">
          <div>
            <p className="text-sm font-bold text-foreground">Shop Expenses this period</p>
            <p className="text-xs text-muted-foreground">USSD/WhatsApp shop activation fees</p>
          </div>
          <p className="text-lg font-black text-foreground">GH₵{periodStats.expenses.toFixed(2)}</p>
        </div>

        {/* Date range */}
        <div className="inline-flex w-full gap-1 rounded-2xl bg-muted p-1">
          {DATE_RANGES.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setDateRange(id)}
              className={`flex-1 rounded-xl py-2 text-xs font-bold transition ${dateRange === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Category pills */}
        <div className="inline-flex w-full gap-1 rounded-2xl bg-muted p-1">
          {CATEGORY_TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setCategory(id)}
              className={`flex-1 rounded-xl py-2 text-xs font-bold transition ${category === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Ledger */}
        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <Activity className="mx-auto mb-2 h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No entries for this filter.</p>
            <p className="text-xs text-muted-foreground">Try changing the period or category.</p>
          </div>
        ) : (
          <div className="space-y-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
            {filtered.map((entry) => {
              const meta = typeMeta[entry.type]
              const Icon = meta.icon
              return (
                <div key={entry.id} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={`grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl ${meta.className}`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{entry.description}</p>
                      <p className="text-xs text-muted-foreground">{new Date(entry.created_at).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <p className={`whitespace-nowrap font-semibold tabular-nums ${entry.type === "earning" ? "text-success" : "text-foreground"}`}>
                    {meta.sign}GH₵{entry.amount.toFixed(2)}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
