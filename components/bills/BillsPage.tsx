"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Lightbulb, RefreshCw, Wallet, Receipt, Wifi } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { supabase } from "@/lib/supabase"
import { BillPayFlow, BillLogo } from "./BillPayFlow"
import { useBillsAvailability } from "./use-bills-availability"
import { BILLERS, isBillerKey } from "@/lib/bills/billers"

interface BillOrder {
  id: string
  reference_code: string
  biller: string
  account_number: string
  customer_name: string | null
  amount: number
  status: string
  payment_status: string
  created_at: string
}

const STATUS_CLASSES: Record<string, string> = {
  pending: "bg-warning/10 text-warning",
  processing: "bg-primary/10 text-primary",
  completed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  refunded: "bg-muted text-muted-foreground",
}

const selectCls =
  "rounded-full border border-white/60 dark:border-white/5 bg-card px-4 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary clay-sm"

function rangeFrom(range: string): string | null {
  const now = new Date()
  if (range === "today") { now.setHours(0, 0, 0, 0); return now.toISOString() }
  if (range === "7d") return new Date(Date.now() - 7 * 864e5).toISOString()
  if (range === "30d") return new Date(Date.now() - 30 * 864e5).toISOString()
  return null
}

export function BillsPage({ page }: { page: "bills" | "broadband" }) {
  const router = useRouter()
  const availability = useBillsAvailability()
  const billers = useMemo(() => (availability?.billers ?? []).filter(b => b.page === page), [availability, page])

  const [balance, setBalance] = useState<number | null>(null)
  const [phone, setPhone] = useState("")
  const [orders, setOrders] = useState<BillOrder[]>([])
  const [loadingOrders, setLoadingOrders] = useState(true)
  const [ordersError, setOrdersError] = useState("")
  const [fBiller, setFBiller] = useState("")
  const [fStatus, setFStatus] = useState("")
  const [fRange, setFRange] = useState("today")

  const title = page === "bills" ? "Utility bills" : "Telecel Broadband"
  const subtitle = page === "bills"
    ? "Pay ECG, Ghana Water and TV subscriptions straight from your wallet"
    : "Pay your Telecel Broadband bill straight from your wallet"
  const HeaderIcon = page === "bills" ? Lightbulb : Wifi

  const loadWallet = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { router.push("/auth/login"); return }
    const [w, u] = await Promise.all([
      supabase.from("wallets").select("balance").eq("user_id", session.user.id).single(),
      supabase.from("users").select("phone").eq("id", session.user.id).single(),
    ])
    setBalance(Number(w.data?.balance ?? 0))
    const p = (u.data as { phone?: string } | null)?.phone
    if (p) setPhone(p)
  }, [router])

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true)
    setOrdersError("")
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setLoadingOrders(false); return }
    const qs = new URLSearchParams()
    if (page === "broadband") qs.set("biller", "telecel_broadband")
    else if (fBiller) qs.set("biller", fBiller)
    if (fStatus) qs.set("status", fStatus)
    const from = rangeFrom(fRange)
    if (from) qs.set("from", from)
    try {
      const res = await fetch(`/api/bills/orders?${qs}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(String(json?.error || "Could not load payments"))
      const all: BillOrder[] = Array.isArray(json.orders) ? json.orders : []
      // Bills page lists everything except broadband (broadband is filtered server-side on its own page).
      setOrders(page === "broadband" ? all : all.filter(o => o.biller !== "telecel_broadband"))
    } catch (e) {
      setOrdersError(e instanceof Error ? e.message : "Could not load payments")
    } finally {
      setLoadingOrders(false)
    }
  }, [fBiller, fStatus, fRange, page])

  useEffect(() => { loadWallet() }, [loadWallet])
  useEffect(() => { loadOrders() }, [loadOrders])

  const onPaid = () => { loadWallet(); loadOrders() }
  const logoFor = (key: string) => billers.find(b => b.key === key)

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl space-y-5 lg:max-w-4xl">
        <div className="flex items-start gap-3">
          <HeaderIcon className="mt-1 h-6 w-6 text-warning" />
          <div>
            <h1 className="text-xl font-bold text-foreground">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        {availability === null ? (
          <div className="py-10 text-center text-muted-foreground">Loading…</div>
        ) : billers.length === 0 ? (
          <div className="rounded-3xl border border-white/60 dark:border-white/5 bg-card p-8 text-center clay">
            <Receipt className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
            <p className="font-bold text-foreground">{page === "bills" ? "Utility bills are not available yet" : "Telecel Broadband payments are not available yet"}</p>
            <p className="mt-1 text-sm text-muted-foreground">Please check back soon.</p>
          </div>
        ) : (
          <>
            <div className="rounded-3xl border border-white/60 dark:border-white/5 bg-card p-5 clay">
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Wallet className="h-4 w-4" /> Wallet balance</p>
              <p className="mt-1 text-3xl font-extrabold text-foreground">
                {balance === null ? "—" : `GH₵${balance.toFixed(2)}`}
              </p>
            </div>

            <section className="space-y-3">
              <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Pay a bill</h2>
              <BillPayFlow billers={billers} balance={balance} defaultPhone={phone} onPaid={onPaid} />
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Recent payments</h2>
                <button type="button" onClick={loadOrders} aria-label="Refresh payments" className="rounded-full p-2 text-muted-foreground hover:text-foreground">
                  <RefreshCw className={`h-4 w-4 ${loadingOrders ? "animate-spin" : ""}`} />
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {billers.length > 1 && (
                  <select aria-label="Biller" className={selectCls} value={fBiller} onChange={e => setFBiller(e.target.value)}>
                    <option value="">All billers</option>
                    {billers.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
                  </select>
                )}
                <select aria-label="Status" className={selectCls} value={fStatus} onChange={e => setFStatus(e.target.value)}>
                  <option value="">All statuses</option>
                  {["pending", "processing", "completed", "failed", "refunded"].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                </select>
                <select aria-label="Date range" className={selectCls} value={fRange} onChange={e => setFRange(e.target.value)}>
                  <option value="today">Today</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="all">All time</option>
                </select>
              </div>

              {ordersError && <p role="alert" className="text-sm text-destructive">{ordersError}</p>}
              {loadingOrders && orders.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">Loading…</div>
              ) : orders.length === 0 ? (
                <div className="py-8 text-center">
                  <Receipt className="mx-auto mb-2 h-10 w-10 text-muted-foreground/40" />
                  <p className="font-bold text-foreground">No bills paid yet</p>
                  <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">Your payments will appear here with live delivery status.</p>
                </div>
              ) : (
                <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
                  {orders.map(o => {
                    const b = logoFor(o.biller)
                    return (
                      <div key={o.id} className="flex items-center gap-3 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                        <BillLogo biller={b ?? { logo: `/billers/${o.biller}.png`, label: o.biller }} size={40} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-foreground">{b?.label ?? (isBillerKey(o.biller) ? BILLERS[o.biller].label : o.biller)}</p>
                          <p className="truncate text-xs text-muted-foreground">{o.customer_name || o.account_number}</p>
                          <p className="text-xs text-muted-foreground">{new Date(o.created_at).toLocaleString()}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-bold text-foreground">GHS {Number(o.amount).toFixed(2)}</p>
                          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASSES[o.status] || "bg-muted text-muted-foreground"}`}>{o.status}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
