"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Eye, RefreshCw, Search } from "lucide-react"
import { BILLER_KEYS, BILLERS, type BillerKey } from "@/lib/bills/billers"
import { BILL_LIMIT_CEIL, BILL_LIMIT_FLOOR, type BillsConfig } from "@/lib/bills/config"
import { botSurfaceStatus, type BotSurfaceStatus } from "@/lib/cashback/bot-surface-status"

type Refund = { action: "blocked"; reason: string } | { action: "ledger"; ref: string; needsForce: boolean } | { action: "direct"; markFailedFirst: boolean }
type Order = {
  id: string; reference_code: string; biller: BillerKey; account_number: string; phone: string | null; email: string | null
  broadband_account: string | null; customer_name: string | null; verified: boolean; amount: number; paid_amount?: number | null
  status: "pending" | "processing" | "completed" | "failed" | "refunded"; payment_status: "unpaid" | "paid" | "refunded"
  hubtel_client_reference: string | null; commission: number | null; failure_reason: string | null; notes: string | null
  created_at: string; updated_at: string; purchaser: string; purchaser_email: string | null; source: string; channel_label?: string | null; shop_name?: string | null; buyer_phone?: string | null
  can_dispatch: boolean; can_retry?: boolean; stuck_claim?: boolean; refund: Refund | null
}
type Stats = { totalSales: number; orders: number; completed: number; inFlight: number; commission: number; failed: number; refunded: number }
type Listing = { rows: Order[]; total: number; offset: number }
type Draft = Record<BillerKey, { min: string; max: string }>

const PAGE_SIZE = 25
const NOTE_MAX = 500
const EMPTY: Listing = { rows: [], total: 0, offset: 0 }

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

async function authed(path: string, init?: RequestInit) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new ApiError("No authentication token available", 401)
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(json.error || json.message || res.statusText || "Request failed", res.status)
  return json
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Request failed")
const money = (n: number | null | undefined, dp = 2) => (n === null || n === undefined ? "-" : `GHS ${Number(n).toFixed(dp)}`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }) : "-")
const DEC = /^\d+(\.\d{1,2})?$/

const PILL = "inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium"
const STATUS_STYLE: Record<string, string> = {
  pending: "bg-slate-100 text-slate-700", processing: "bg-blue-100 text-blue-700", completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700", refunded: "bg-violet-100 text-violet-700",
}
const PAY_STYLE: Record<string, string> = { paid: "bg-emerald-100 text-emerald-700", unpaid: "bg-slate-100 text-slate-600", refunded: "bg-violet-100 text-violet-700" }
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function SurfaceRow({ title, detail, state, on, link }: {
  title: string; detail: string; state: string; on: boolean; link?: { href: string; label: string }
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
        {link && <Link href={link.href} className="mt-1 inline-block text-xs font-semibold text-primary underline">{link.label}</Link>}
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${on ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{state}</span>
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className={`mt-1 text-xl font-semibold sm:text-2xl ${tone ?? ""}`}>{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}

function Logo({ biller, size = 28 }: { biller: BillerKey; size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={BILLERS[biller].logo} alt="" width={size} height={size} className="shrink-0 rounded-md object-contain" />
}

function Pager({ listing, loading, onPage }: { listing: Listing; loading: boolean; onPage: (offset: number) => void }) {
  const from = listing.total === 0 ? 0 : listing.offset + 1
  const to = Math.min(listing.offset + PAGE_SIZE, listing.total)
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
      <span>{from}-{to} of {listing.total}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={loading || listing.offset <= 0} onClick={() => onPage(Math.max(0, listing.offset - PAGE_SIZE))}>Previous</Button>
        <Button size="sm" variant="outline" disabled={loading || listing.offset + PAGE_SIZE >= listing.total} onClick={() => onPage(listing.offset + PAGE_SIZE)}>Next</Button>
      </div>
    </div>
  )
}

function OrderRow({ o, busy, onDetails, onSync, onDispatch, onRetry, onRefund, queue }: {
  o: Order; busy: boolean; queue?: boolean
  onDetails: (o: Order) => void; onSync: (o: Order) => void; onDispatch: (o: Order) => void; onRetry: (o: Order) => void; onRefund: (o: Order) => void
}) {
  const unverified = !o.verified
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 lg:flex-row lg:items-center lg:gap-5">
      <div className="lg:w-48">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Biller</div>
        <div className="mt-1 flex items-center gap-2 font-medium"><Logo biller={o.biller} /><span className="truncate">{BILLERS[o.biller]?.label ?? o.biller}</span></div>
      </div>
      <div className="min-w-0 lg:w-56">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Account</div>
        {unverified
          ? <div className="truncate text-sm font-medium text-amber-600">Unverified — entered manually</div>
          : <div className="truncate text-sm font-medium">{o.customer_name ?? "Verified account"}</div>}
        <div className="font-mono text-xs text-muted-foreground break-all">{o.account_number}</div>
      </div>
      <div className="min-w-0 lg:w-44">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Purchaser</div>
        <div className="truncate text-sm font-semibold" title={o.purchaser_email ?? undefined}>{o.purchaser}</div>
        <span className={`${PILL} bg-sky-50 text-sky-700 text-[11px]`}>{o.source === "bots" ? (o.channel_label ?? "Bot") : o.source === "api" ? "API" : cap(o.source)}</span>
        {o.shop_name && <div className="truncate text-xs text-muted-foreground">Shop: {o.shop_name}</div>}
        {(o.source === "storefront" || o.source === "bots") && o.buyer_phone && <div className="font-mono text-xs text-muted-foreground">{o.buyer_phone}</div>}
      </div>
      <div className="lg:w-44">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Status</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <span className={`${PILL} ${PAY_STYLE[o.payment_status] ?? ""}`}>{cap(o.payment_status)}</span>
          <span className={`${PILL} ${STATUS_STYLE[o.status] ?? ""}`}>{o.status === "pending" && o.payment_status === "paid" ? "Pending" : cap(o.status)}</span>
        </div>
        {o.stuck_claim && <div className="mt-1 text-xs font-medium text-amber-700">Stuck dispatch (never reached Hubtel)</div>}
        {(o.failure_reason || (o.notes && o.status !== "completed")) && (
          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{o.failure_reason ?? o.notes}</div>
        )}
      </div>
      <div className="lg:w-40">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Time</div>
        <div className="text-sm font-medium">{when(o.created_at)}</div>
      </div>
      <div className="lg:w-28 lg:text-right">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Amount</div>
        <div className="text-lg font-semibold">{money(o.amount)}</div>
        {o.paid_amount != null && <div className="text-xs text-muted-foreground">Paid {money(o.paid_amount)}</div>}
        {o.commission !== null && <div className="text-xs text-emerald-600">+{Number(o.commission).toFixed(4)} comm.</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:justify-end">
        <Button size="icon" variant="ghost" aria-label="Order details" onClick={() => onDetails(o)}><Eye className="h-4 w-4" /></Button>
        {o.status === "processing" && o.hubtel_client_reference && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onSync(o)}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Sync</Button>
        )}
        {o.can_dispatch && <Button size="sm" disabled={busy} onClick={() => onDispatch(o)}>Dispatch</Button>}
        {o.can_retry && <Button size="sm" variant="outline" disabled={busy} onClick={() => onRetry(o)}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Retry</Button>}
        {/* Storefront buyers have no wallet: their refunds go through /admin/refunds (the server refuses a wallet refund). */}
        {queue && o.refund && (o.source === "storefront" || o.source === "bots") && (
          <div className="flex flex-col items-end gap-1">
            <Link href="/admin/refunds" className="text-xs font-medium text-primary underline-offset-2 hover:underline">Storefront / bot order — refund from Refunds</Link>
            {o.refund.action === "blocked" && <div className="max-w-64 text-right text-xs text-amber-700">{o.refund.reason}</div>}
          </div>
        )}
        {queue && o.refund && o.source !== "storefront" && o.source !== "bots" && (
          <div className="flex flex-col items-end gap-1">
            <Button size="sm" disabled={busy || o.refund.action === "blocked"} onClick={() => onRefund(o)}>Refund to wallet</Button>
            {o.refund.action === "blocked" && <div className="max-w-64 text-right text-xs text-amber-700">{o.refund.reason}</div>}
          </div>
        )}
        {queue && o.can_dispatch && (
          <div className="max-w-64 text-right text-xs text-muted-foreground">Debited but never sent: dispatch it, or refund.</div>
        )}
      </div>
    </div>
  )
}

export default function UtilityBillsPage() {
  const [tab, setTab] = useState("orders")
  const [orders, setOrders] = useState<Listing>(EMPTY)
  const [stats, setStats] = useState<Stats | null>(null)
  const [queue, setQueue] = useState<Listing>(EMPTY)
  const [refunded, setRefunded] = useState<Listing>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState<BillsConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  /** Live storefront/cashback state for bills, read from the Cashback settings (null = not loaded). */
  const [surfaces, setSurfaces] = useState<{
    storefront: boolean; feePct: number
    shares: { customer: number; dealer: number; storefrontCustomer: number; storefrontShop: number } | null
    bots: BotSurfaceStatus
  } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [details, setDetails] = useState<Order | null>(null)
  const [refunding, setRefunding] = useState<Order | null>(null)
  const [note, setNote] = useState("")
  const [ack, setAck] = useState(false)
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)

  const [qInput, setQInput] = useState("")
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const [biller, setBiller] = useState("all")
  const [paidOnly, setPaidOnly] = useState("paid")
  const [channel, setChannel] = useState("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")

  const actionInFlight = useRef(false)
  const seq = useRef({ orders: 0, queue: 0, refunded: 0 })

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 350)
    return () => clearTimeout(t)
  }, [qInput])

  const toDraft = (c: BillsConfig): Draft =>
    Object.fromEntries(BILLER_KEYS.map(k => [k, { min: String(c.billers[k].min), max: String(c.billers[k].max) }])) as Draft

  const loadConfig = useCallback(async () => {
    try {
      const j = await authed("/api/admin/utility-bills/config")
      setConfig(j.config); setDraft(toDraft(j.config)); setConfigError(null)
    } catch (e) { setConfigError(errMsg(e)); toast.error(`Settings: ${errMsg(e)}`) }
    // Best-effort: the Surfaces / cashback cards just show "—" if this fails.
    try {
      const c = (await authed("/api/admin/cashback/config")).config
      // Each bot's own Pay Bills switch; a source that fails to load shows that bot as off.
      const [hubtel, uzo, wa] = await Promise.all([
        authed("/api/admin/ussd-hubtel/config").then(j => j?.config ?? null).catch(() => null),
        authed("/api/admin/ussd/service-visibility").then(j => j?.status ?? null).catch(() => null),
        authed("/api/admin/whatsapp/cashback-visibility").then(j => j?.switches ?? null).catch(() => null),
      ])
      setSurfaces({
        storefront: !!(c?.enabled && c?.surfaces?.storefront && c?.storefrontGroups?.bills),
        feePct: Number(c?.paymentFee?.bills ?? 0),
        shares: c?.shares?.bills ?? null,
        bots: botSurfaceStatus("bills", c, hubtel, uzo, wa),
      })
    } catch { setSurfaces(null) }
  }, [])

  const loadOrders = useCallback(async (scope: "orders" | "queue" | "refunded", offset: number, withStats = false): Promise<void> => {
    const id = ++seq.current[scope]
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (scope === "orders") {
      if (q) p.set("q", q)
      if (status !== "all") p.set("status", status)
      if (biller !== "all") p.set("biller", biller)
      if (channel !== "all") p.set("channel", channel)
      if (paidOnly === "paid") p.set("paidOnly", "true")
      if (from) p.set("from", from)
      if (to) p.set("to", to)
      if (withStats) p.set("stats", "1")
    } else p.set("view", scope === "queue" ? "refund" : "refunded")
    try {
      const j = await authed(`/api/admin/utility-bills/orders?${p}`)
      if (id !== seq.current[scope]) return
      const total: number = j.total ?? 0
      const maxOffset = total > 0 ? Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE : 0
      if (offset > maxOffset) { await loadOrders(scope, maxOffset, withStats); return }
      const next: Listing = { rows: j.rows ?? [], total, offset }
      if (scope === "orders") { setOrders(next); if (j.stats !== undefined) setStats(j.stats) } else if (scope === "queue") setQueue(next); else setRefunded(next)
    } catch (e) {
      if (id === seq.current[scope]) toast.error(`${scope === "orders" ? "Orders" : "Refund queue"}: ${errMsg(e)}`)
    }
  }, [q, status, biller, channel, paidOnly, from, to])

  const reloadLists = useCallback(async () => {
    setLoading(true)
    try { await Promise.all([loadOrders("orders", 0, true), loadOrders("queue", 0), loadOrders("refunded", 0)]) } finally { setLoading(false) }
  }, [loadOrders])
  const reloadAll = useCallback(async () => {
    setLoading(true)
    try { await Promise.all([loadConfig(), loadOrders("orders", 0, true), loadOrders("queue", 0), loadOrders("refunded", 0)]) } finally { setLoading(false) }
  }, [loadConfig, loadOrders])
  useEffect(() => { void loadConfig() }, [loadConfig])
  useEffect(() => { void reloadLists() }, [reloadLists])

  const refreshLists = () => Promise.all([loadOrders("orders", orders.offset, true), loadOrders("queue", queue.offset), loadOrders("refunded", refunded.offset)])

  /** One mutating action at a time across the whole page. */
  async function guarded(key: string, fn: () => Promise<void>) {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy(key)
    try { await fn() } finally { actionInFlight.current = false; setBusy(null) }
  }

  const saveConfig = (patch: object, okMsg = "Saved") =>
    guarded("config", async () => {
      try {
        const j = await authed("/api/admin/utility-bills/config", { method: "POST", body: JSON.stringify(patch) })
        setConfig(j.config); setDraft(toDraft(j.config)); toast.success(okMsg)
      } catch (e) { toast.error(errMsg(e)) }
    })

  const limitErrors = (): Partial<Record<BillerKey, string>> => {
    const out: Partial<Record<BillerKey, string>> = {}
    if (!draft) return out
    for (const k of BILLER_KEYS) {
      const { min, max } = draft[k]
      const lo = Number(min), hi = Number(max)
      if (!DEC.test(min.trim()) || !DEC.test(max.trim()) || !(lo >= BILL_LIMIT_FLOOR) || !(hi <= BILL_LIMIT_CEIL) || lo > hi) {
        out[k] = `${BILL_LIMIT_FLOOR} ≤ min ≤ max ≤ ${BILL_LIMIT_CEIL.toLocaleString()}`
      }
    }
    return out
  }
  const errors = limitErrors()
  const dirty = !!config && !!draft && BILLER_KEYS.some(k => Number(draft[k].min) !== config.billers[k].min || Number(draft[k].max) !== config.billers[k].max)

  const saveLimits = () => {
    if (!config || !draft || Object.keys(errors).length > 0) return
    const billers = Object.fromEntries(BILLER_KEYS.map(k => [k, { enabled: config.billers[k].enabled, min: Number(draft[k].min), max: Number(draft[k].max) }]))
    return saveConfig({ billers }, "Limits saved")
  }
  const toggleBiller = (k: BillerKey, enabled: boolean) => {
    if (!config) return
    // Persist the saved limits (not unsaved edits) alongside the toggle.
    return saveConfig({ billers: { [k]: { enabled, min: config.billers[k].min, max: config.billers[k].max } } }, `${BILLERS[k].label} ${enabled ? "on" : "off"}`)
  }

  const sync = (o: Order) => guarded(`sync-${o.id}`, async () => {
    try {
      const j = await authed("/api/admin/hubtel-cs/check-status", { method: "POST", body: JSON.stringify({ ref: o.hubtel_client_reference }) })
      if (j.ok) toast.success(j.message ?? "Status checked"); else toast.error(j.message ?? "Status check failed")
    } catch (e) { toast.error(errMsg(e)) }
    await refreshLists()
  })

  const dispatch = (o: Order) => {
    if (!window.confirm(`Send ${money(o.amount)} ${BILLERS[o.biller]?.label ?? o.biller} (${o.account_number}) to Hubtel now?`)) return
    return guarded(`dispatch-${o.id}`, async () => {
      try {
        const j = await authed("/api/admin/utility-bills/dispatch", { method: "POST", body: JSON.stringify({ orderId: o.id }) })
        if (j.ok) toast.success(j.message ?? "Dispatched"); else toast.error(j.message ?? "Not sent")
      } catch (e) { toast.error(errMsg(e)) }
      await refreshLists()
    })
  }

  const retry = (o: Order) => {
    if (!window.confirm(`Hubtel failed this order. Send ${money(o.amount)} ${BILLERS[o.biller]?.label ?? o.biller} (${o.account_number}) to Hubtel again?`)) return
    return guarded(`retry-${o.id}`, async () => {
      try {
        const j = await authed("/api/admin/utility-bills/retry", { method: "POST", body: JSON.stringify({ orderId: o.id }) })
        if (j.ok) toast.success(j.message ?? "Retried"); else toast.error(j.message ?? "Not sent")
      } catch (e) { toast.error(errMsg(e)) }
      await refreshLists()
    })
  }

  const noteOk = note.trim().length > 0 && note.trim().length <= NOTE_MAX
  const needsForce = refunding?.refund?.action === "ledger" && refunding.refund.needsForce
  const confirmRefund = () => {
    if (!refunding || !noteOk || (needsForce && !ack)) return
    const row = refunding
    return guarded("refund", async () => {
      try {
        const j = await authed("/api/admin/utility-bills/refund", {
          method: "POST", body: JSON.stringify({ orderId: row.id, note: note.trim(), ...(needsForce ? { force: true } : {}) }),
        })
        setBanner({ ok: true, text: `${row.reference_code}: ${j.message}` })
        toast.success("Refund processed")
      } catch (e) {
        // Non-2xx keeps the server's message (e.g. outcome UNKNOWN: check the wallet) visible until dismissed.
        setBanner({ ok: false, text: `${row.reference_code}: ${errMsg(e)}` })
        toast.error(errMsg(e))
      }
      setRefunding(null)
      await refreshLists()
    })
  }

  const anyBusy = busy !== null
  const rowBusy = anyBusy || loading
  const openRefund = (o: Order) => { if (o.source === "storefront" || o.source === "bots") return; setNote(""); setAck(false); setRefunding(o) }
  const rowProps = { busy: rowBusy, onDetails: setDetails, onSync: sync, onDispatch: dispatch, onRetry: retry, onRefund: openRefund }
  const queueCount = queue.total

  return (
    <DashboardLayout>
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <PageHeaderBanner title="Utility Bills" subtitle="ECG, Ghana Water, DSTV, GOtv & StarTimes — gates, economics & orders">
          <Button variant="secondary" size="sm" onClick={reloadAll} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
        </PageHeaderBanner>

        {banner && (
          <Card className={banner.ok ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}>
            <CardContent className="flex items-start justify-between gap-3 p-4">
              <div className={`text-sm ${banner.ok ? "text-emerald-900" : "text-red-900"}`}>{banner.text}</div>
              <Button size="sm" variant="ghost" onClick={() => setBanner(null)}>Dismiss</Button>
            </CardContent>
          </Card>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="refunds">Refund Queue{queueCount ? ` (${queueCount})` : ""}</TabsTrigger>
          </TabsList>

          <TabsContent value="orders" className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <Stat label="Sales (face value)" value={stats ? money(stats.totalSales) : "—"} hint={stats ? `${stats.orders} orders in view` : undefined} tone="text-emerald-600" />
              <Stat label="Orders" value={stats ? String(stats.orders) : "—"} hint={stats ? `${stats.completed} completed · ${stats.inFlight} in flight` : undefined} />
              <Stat label="Hubtel commission earned" value={stats ? money(stats.commission, 4) : "—"} hint="Across filtered window" tone="text-emerald-600" />
              <Stat label="Failed / Refunded" value={stats ? String(stats.failed + stats.refunded) : "—"} hint={stats ? `${stats.failed} failed · ${stats.refunded} refunded` : undefined} tone="text-red-500" />
            </div>

            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto_auto]">
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input className="pl-9" placeholder="Search reference, account number, or name…" value={qInput} onChange={e => setQInput(e.target.value)} maxLength={100} />
                  </div>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="lg:w-40" aria-label="Status"><SelectValue placeholder="All statuses" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      {["pending", "processing", "completed", "failed", "refunded"].map(s => <SelectItem key={s} value={s}>{cap(s)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={biller} onValueChange={setBiller}>
                    <SelectTrigger className="lg:w-44" aria-label="Biller"><SelectValue placeholder="All billers" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All billers</SelectItem>
                      {BILLER_KEYS.map(k => <SelectItem key={k} value={k}>{BILLERS[k].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={channel} onValueChange={setChannel}>
                    <SelectTrigger className="lg:w-36" aria-label="Channel"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All channels</SelectItem>
                      <SelectItem value="dashboard">Dashboard</SelectItem>
                      <SelectItem value="storefront">Storefront</SelectItem>
                      <SelectItem value="api">API</SelectItem>
                      <SelectItem value="bots">Bots</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={paidOnly} onValueChange={setPaidOnly}>
                    <SelectTrigger className="lg:w-36" aria-label="Payment"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="paid">Paid only</SelectItem>
                      <SelectItem value="all">All payments</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>From</span>
                  <Input type="date" className="w-40" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} aria-label="From date" />
                  <span>to</span>
                  <Input type="date" className="w-40" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} aria-label="To date" />
                </div>
              </CardContent>
            </Card>

            <div className="space-y-3">
              {orders.rows.length === 0 && <div className="rounded-xl border p-8 text-center text-sm text-muted-foreground">{loading ? "Loading…" : "No orders match these filters."}</div>}
              {orders.rows.map(o => <OrderRow key={o.id} o={o} {...rowProps} />)}
            </div>
            <Pager listing={orders} loading={loading} onPage={off => { void loadOrders("orders", off) }} />
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            {configError && !config && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900">
                Could not load settings: {configError}
                <Button size="sm" variant="outline" className="ml-3" onClick={() => { void loadConfig() }}>Retry</Button>
              </div>
            )}
            {config && draft && (
              <div className="grid gap-4 lg:grid-cols-3">
                <Card>
                  <CardHeader>
                    <CardTitle>Feature gates</CardTitle>
                    <CardDescription>Master switches &amp; per-biller availability</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
                      <div>
                        <div className="font-medium">Utility bills enabled</div>
                        <div className="text-xs text-muted-foreground">Master switch — turns the whole feature on or off</div>
                      </div>
                      <Switch aria-label="Utility bills enabled" checked={config.enabled} disabled={anyBusy} onCheckedChange={v => saveConfig({ enabled: v }, v ? "Enabled" : "Disabled")} />
                    </div>
                    <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
                      <div>
                        <div className="font-medium">Auto-fulfilment</div>
                        <div className="text-xs text-muted-foreground">Dispatch paid orders to Hubtel automatically. Off: paid orders wait for an admin to press Dispatch.</div>
                      </div>
                      <Switch aria-label="Auto-fulfilment" checked={config.autoFulfil} disabled={anyBusy} onCheckedChange={v => saveConfig({ autoFulfil: v }, v ? "Auto-fulfilment on" : "Auto-fulfilment off")} />
                    </div>
                    <div className="pt-2 text-sm font-medium">Enabled billers</div>
                    <div className="text-xs text-muted-foreground">Controls which billers customers can pay, and which are eligible for auto-fulfilment.</div>
                    {BILLER_KEYS.map(k => (
                      <div key={k} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                        <div className="flex items-center gap-3 font-medium"><Logo biller={k} size={32} />{BILLERS[k].label}</div>
                        <Switch aria-label={`${BILLERS[k].label} enabled`} checked={config.billers[k].enabled} disabled={anyBusy} onCheckedChange={v => toggleBiller(k, v)} />
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Surfaces</CardTitle>
                    <CardDescription>Where customers can pay a bill</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <SurfaceRow title="Dashboard" detail="Logged-in customers pay from their wallet" state={config.enabled ? "On" : "Off"} on={config.enabled} />
                    <SurfaceRow
                      title="Shop storefronts"
                      detail={surfaces
                        ? `Paid with Paystack (MoMo prompt / card). Payment fee ${surfaces.feePct}% on top.`
                        : "Paid with Paystack (MoMo prompt / card)."}
                      state={surfaces === null ? "—" : surfaces.storefront ? "On" : "Off"}
                      on={!!surfaces?.storefront}
                      link={{ href: "/admin/hubtel-commission?tab=cashback", label: "Change in Cashback" }}
                    />
                    <SurfaceRow
                      title="Hubtel USSD"
                      detail="Pay Bills on the Hubtel code (paid at Hubtel checkout)"
                      state={surfaces === null ? "—" : surfaces.bots.hubtel ? "On" : "Off"}
                      on={!!surfaces?.bots.hubtel}
                      link={{ href: "/admin/ussd-hubtel", label: "Menu switch" }}
                    />
                    <SurfaceRow
                      title="Uzo USSD (main + shop)"
                      detail="Pay Bills on the Uzo menus (MoMo prompt to the dialing number)"
                      state={surfaces === null ? "—" : surfaces.bots.uzo ? "On" : "Off"}
                      on={!!surfaces?.bots.uzo}
                      link={{ href: "/admin/ussd-shops", label: "Menu switch" }}
                    />
                    <SurfaceRow
                      title="WhatsApp bots (main + shop)"
                      detail="Pay Bills in chat, incl. Ghana Water (MoMo prompt to the typed number)"
                      state={surfaces === null ? "—" : surfaces.bots.whatsapp ? "On" : "Off"}
                      on={!!surfaces?.bots.whatsapp}
                      link={{ href: "/admin/whatsapp", label: "Menu switch" }}
                    />
                    {surfaces && !surfaces.bots.gate && (
                      <p className="text-xs text-muted-foreground">
                        Bots are off for bills in Cashback (master, Bots surface or &quot;Sell on bots&quot;), so no bot sells Pay Bills.{" "}
                        <Link href="/admin/hubtel-commission?tab=cashback" className="font-semibold text-primary underline">Change in Cashback</Link>
                      </p>
                    )}
                  </CardContent>
                </Card>

                <div className="space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>Shop &amp; customer cashback</CardTitle>
                      <CardDescription>Shares of Hubtel&apos;s bill commission given to buyers and shop owners</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      {surfaces?.shares ? (
                        <>
                          <div className="flex justify-between"><span className="text-muted-foreground">Dashboard customer / dealer</span><span>{surfaces.shares.customer}% / {surfaces.shares.dealer}%</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Storefront buyer / shop owner</span><span>{surfaces.shares.storefrontCustomer}% / {surfaces.shares.storefrontShop}%</span></div>
                        </>
                      ) : (
                        <div className="text-muted-foreground">Set up in Cashback.</div>
                      )}
                      <Link href="/admin/hubtel-commission?tab=cashback" className="inline-block text-xs font-semibold text-primary underline">Manage rates &amp; shares in Cashback</Link>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Transaction limits (GHS)</CardTitle>
                      <CardDescription>Per biller. {BILL_LIMIT_FLOOR} ≤ min ≤ max ≤ {BILL_LIMIT_CEIL.toLocaleString()}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {BILLER_KEYS.map(k => (
                        <div key={k}>
                          <div className="mb-1 flex items-center gap-2 text-sm font-medium"><Logo biller={k} size={20} />{BILLERS[k].label}</div>
                          <div className="grid grid-cols-2 gap-2">
                            <Input inputMode="decimal" aria-label={`${BILLERS[k].label} minimum`} placeholder="Min" value={draft[k].min}
                              onChange={e => setDraft({ ...draft, [k]: { ...draft[k], min: e.target.value } })} />
                            <Input inputMode="decimal" aria-label={`${BILLERS[k].label} maximum`} placeholder="Max" value={draft[k].max}
                              onChange={e => setDraft({ ...draft, [k]: { ...draft[k], max: e.target.value } })} />
                          </div>
                          {errors[k] && <div className="mt-1 text-xs text-red-600">{errors[k]}</div>}
                        </div>
                      ))}
                      <Button disabled={anyBusy || !dirty || Object.keys(errors).length > 0} onClick={saveLimits}>Save limits</Button>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="refunds" className="mt-4 space-y-4">
            <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
              Paid orders that failed, plus paid orders that were never sent to Hubtel. A refund is blocked while a Hubtel transaction is still pending or needs review.
            </div>
            <div className="space-y-3">
              {queue.rows.length === 0 && <div className="rounded-xl border p-8 text-center text-sm text-muted-foreground">{loading ? "Loading…" : "Nothing waiting for a refund."}</div>}
              {queue.rows.map(o => <OrderRow key={o.id} o={o} queue {...rowProps} />)}
            </div>
            <Pager listing={queue} loading={loading} onPage={off => { void loadOrders("queue", off) }} />
            <div className="pt-2 text-sm font-semibold">Refunded</div>
            <div className="space-y-3">
              {refunded.rows.length === 0 && <div className="rounded-xl border p-6 text-center text-sm text-muted-foreground">No refunds yet.</div>}
              {refunded.rows.map(o => <OrderRow key={o.id} o={o} {...rowProps} />)}
            </div>
            <Pager listing={refunded} loading={loading} onPage={off => { void loadOrders("refunded", off) }} />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={!!details} onOpenChange={o => { if (!o) setDetails(null) }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Order {details?.reference_code}</DialogTitle>
            <DialogDescription>{details ? BILLERS[details.biller]?.label : ""}</DialogDescription>
          </DialogHeader>
          {details && (
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
              {([
                ["Status", `${cap(details.payment_status)} · ${cap(details.status)}`],
                ["Amount", money(details.amount)],
                ["Commission", details.commission === null ? "-" : money(details.commission, 4)],
                ["Account", details.account_number],
                ["Account name", details.customer_name ?? (details.verified ? "-" : "Unverified — entered manually")],
                ["Phone", details.phone ?? "-"],
                ["Email", details.email ?? "-"],
                ["Broadband acct", details.broadband_account ?? "-"],
                ["Purchaser", `${details.purchaser}${details.purchaser_email ? ` (${details.purchaser_email})` : ""}`],
                ["Hubtel reference", details.hubtel_client_reference ?? "Never sent"],
                ["Failure reason", details.failure_reason ?? "-"],
                ["Notes", details.notes ?? "-"],
                ["Created", when(details.created_at)],
                ["Updated", when(details.updated_at)],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="break-all">{v}</dd></div>
              ))}
            </dl>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!refunding} onOpenChange={o => { if (!o && !anyBusy) setRefunding(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refund to wallet</DialogTitle>
            <DialogDescription>
              {refunding && `${money(refunding.amount)} for ${BILLERS[refunding.biller]?.label} (${refunding.account_number}) goes back to ${refunding.purchaser}'s wallet.`}
              {refunding?.refund?.action === "direct" && refunding.refund.markFailedFirst && " This order was never sent to Hubtel; it will be marked failed first."}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={note} onChange={e => setNote(e.target.value)} maxLength={NOTE_MAX} placeholder="Note (required, kept in the audit log)" aria-label="Refund note" />
          <div className="text-xs text-muted-foreground">{note.trim().length}/{NOTE_MAX}</div>
          {needsForce && (
            <label className="flex items-start gap-2 text-sm text-amber-800">
              <input type="checkbox" className="mt-1" checked={ack} onChange={e => setAck(e.target.checked)} />
              This Hubtel row was marked failed by an admin override, not by Hubtel. I confirm the bill was not delivered.
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={anyBusy} onClick={() => setRefunding(null)}>Cancel</Button>
            <Button disabled={anyBusy || !noteOk || (!!needsForce && !ack)} onClick={confirmRefund}>{busy === "refund" ? "Refunding…" : "Refund to wallet"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
