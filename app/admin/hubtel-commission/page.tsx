"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { RefreshCw, Search } from "lucide-react"
import { HUBTEL_CS_SERVICES, isServiceKey, type HubtelCsServiceKey } from "@/lib/hubtel-cs/services"
import type { HubtelCsConfig } from "@/lib/hubtel-cs/config"
import type { HubtelCsTx } from "@/lib/hubtel-cs/types"

type Row = HubtelCsTx & { refundable: boolean }
type Stats = { total: number; in_flight: number; needs_review: number; failed: number; fulfilled: number; commission_earned: number }
type EnvStatus = { ready: boolean; missing: string[] }
type ServiceInfo = { key: HubtelCsServiceKey; label: string; kind: string }
type Scope = "transactions" | "review"
type Listing = { rows: Row[]; total: number; offset: number }

const PAGE_SIZE = 25
const NOTE_MAX = 500
const TEST_MAX = 5

class ApiError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function authed(path: string, init?: RequestInit) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new ApiError("No authentication token available", 401, null)
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(json.error || json.message || res.statusText || "Request failed", res.status, json)
  return json
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Request failed")
const money = (n: number | null | undefined, dp = 2) => (n === null || n === undefined ? "-" : `GHS ${Number(n).toFixed(dp)}`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }) : "-")

const STATE_STYLE: Record<string, string> = {
  created: "bg-slate-100 text-slate-700",
  pending: "bg-blue-100 text-blue-700",
  fulfilled: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  needs_review: "bg-amber-100 text-amber-800",
}
const StateBadge = ({ state }: { state: string }) => (
  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_STYLE[state] ?? "bg-slate-100 text-slate-700"}`}>{state.replace("_", " ")}</span>
)

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

function TxRow({ r, review, busy, onCheck, onResolve, onRefund }: {
  r: Row
  review?: boolean
  busy: boolean
  onCheck: (r: Row) => void
  onResolve: (r: Row, outcome: "fulfilled" | "failed") => void
  onRefund: (r: Row) => void
}) {
  const svc = isServiceKey(r.service_key) ? HUBTEL_CS_SERVICES[r.service_key] : undefined
  const canCheck = r.state === "pending" || r.state === "needs_review"
  const canMarkFulfilled = review && (r.state === "needs_review" || (r.state === "failed" && !r.refund_claimed_at))
  const canMarkFailed = review && r.state === "needs_review"
  const claimed = !!r.refund_claimed_at
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 lg:flex-row lg:items-center lg:gap-6">
      <div className="lg:w-44">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Service</div>
        <div className="font-medium">{svc?.label ?? r.service_key}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Destination</div>
        <div className="font-mono text-sm break-all">{r.destination}</div>
        <button type="button" className="break-all text-left font-mono text-xs text-muted-foreground underline decoration-dotted"
          title="Click to copy"
          onClick={() => { navigator.clipboard?.writeText(r.client_reference).then(() => toast.success("Reference copied"), () => toast.error("Copy failed")) }}>
          {r.client_reference}
        </button>
      </div>
      <div className="lg:w-56">
        <StateBadge state={r.state} />
        {(r.failure_reason || r.review_reason) && <div className="mt-1 text-xs text-muted-foreground">{r.failure_reason ?? r.review_reason}</div>}
        {r.resolved_by && (
          <div className="mt-1 text-xs text-amber-700">
            Admin override ({r.resolved_by.slice(0, 8)}): {r.resolution_note ?? "no note"}
          </div>
        )}
        {claimed && <div className="mt-1 text-xs font-medium text-emerald-700">Refund claimed/processed ({when(r.refund_claimed_at)})</div>}
      </div>
      <div className="lg:w-36">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{when(r.created_at)}</div>
        <div className="font-semibold">{money(r.amount)}</div>
        {r.commission !== null && <div className="text-xs text-emerald-600">+{money(r.commission, 4)} comm.</div>}
      </div>
      <div className="flex flex-wrap gap-2 lg:w-64 lg:justify-end">
        {canCheck && <Button size="sm" variant="outline" disabled={busy} onClick={() => onCheck(r)}>Check status</Button>}
        {canMarkFulfilled && <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve(r, "fulfilled")}>Mark delivered</Button>}
        {canMarkFailed && <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve(r, "failed")}>Mark failed</Button>}
        {review && r.state === "failed" && !claimed && (
          <Button size="sm" disabled={busy || !r.refundable} title={r.refundable ? "" : "No refund handler is registered for this order type"} onClick={() => onRefund(r)}>
            Refund to wallet
          </Button>
        )}
      </div>
    </div>
  )
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

export default function HubtelCommissionPage() {
  const [config, setConfig] = useState<HubtelCsConfig | null>(null)
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [services, setServices] = useState<ServiceInfo[]>([])
  const [configError, setConfigError] = useState<string | null>(null)
  const [txList, setTxList] = useState<Listing>({ rows: [], total: 0, offset: 0 })
  const [reviewList, setReviewList] = useState<Listing>({ rows: [], total: 0, offset: 0 })
  const [stats, setStats] = useState<Stats | null>(null)
  const [filter, setFilter] = useState("all")
  const [qInput, setQInput] = useState("")
  const [q, setQ] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [threshold, setThreshold] = useState("")
  const [test, setTest] = useState({ serviceKey: "airtime_mtn" as HubtelCsServiceKey, destination: "", amount: "0.50", bundle: "" })
  const [testBusy, setTestBusy] = useState(false)
  const testInFlight = useRef(false)
  const actionInFlight = useRef(false)
  const [testLock, setTestLock] = useState(0)
  const [testResult, setTestResult] = useState<{ kind: "ok" | "unknown" | "error"; text: string; ref?: string } | null>(null)
  const [resolving, setResolving] = useState<{ row: Row; outcome: "fulfilled" | "failed" } | null>(null)
  const [note, setNote] = useState("")
  const [ack, setAck] = useState(false)
  const [refunding, setRefunding] = useState<Row | null>(null)
  const [refundAck, setRefundAck] = useState(false)
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)
  const seq = useRef({ transactions: 0, review: 0 })

  const loadConfig = useCallback(async (opts?: { keepThreshold?: boolean }) => {
    try {
      const j = await authed("/api/admin/hubtel-cs/config")
      setConfig(j.config); setEnv(j.env); setServices(j.services ?? [])
      if (!opts?.keepThreshold) setThreshold(j.config.lowBalanceThreshold == null ? "" : String(j.config.lowBalanceThreshold))
      setConfigError(null)
    } catch (e) {
      setConfigError(errMsg(e)); toast.error(`Settings: ${errMsg(e)}`)
    }
  }, [])

  const loadList = useCallback(async (scope: Scope, offset: number): Promise<void> => {
    const id = ++seq.current[scope]
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (scope === "review") params.set("state", "attention")
    else {
      if (filter !== "all") params.set("state", filter)
      if (q.trim()) params.set("q", q.trim())
    }
    try {
      const j = await authed(`/api/admin/hubtel-cs/transactions?${params}`)
      if (id !== seq.current[scope]) return
      const total: number = j.total ?? 0
      const maxOffset = total > 0 ? Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE : 0
      if (offset > maxOffset) { await loadList(scope, maxOffset); return }
      const next: Listing = { rows: j.rows ?? [], total, offset }
      if (scope === "review") setReviewList(next); else setTxList(next)
      if (j.stats) setStats(j.stats)
    } catch (e) {
      if (id === seq.current[scope]) toast.error(`${scope === "review" ? "Review queue" : "Transactions"}: ${errMsg(e)}`)
    }
  }, [filter, q])

  const reloadLists = useCallback(async () => {
    setLoading(true)
    try { await Promise.all([loadList("transactions", 0), loadList("review", 0)]) }
    finally { setLoading(false) }
  }, [loadList])
  const reloadAll = useCallback(async () => {
    setLoading(true)
    try { await Promise.all([loadConfig(), loadList("transactions", 0), loadList("review", 0)]) }
    finally { setLoading(false) }
  }, [loadConfig, loadList])
  // Config loads once; changing the filter/search only reloads the lists (never clobbers an unsaved threshold).
  useEffect(() => { void loadConfig() }, [loadConfig])
  useEffect(() => { void reloadLists() }, [reloadLists])
  useEffect(() => {
    if (testLock <= 0) return
    const t = setTimeout(() => setTestLock(n => Math.max(0, n - 1)), 1000)
    return () => clearTimeout(t)
  }, [testLock])

  const refreshLists = () => Promise.all([loadList("transactions", txList.offset), loadList("review", reviewList.offset)])

  async function patchConfig(patch: object, okMsg = "Saved") {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy("config")
    try {
      const j = await authed("/api/admin/hubtel-cs/config", { method: "POST", body: JSON.stringify(patch) })
      setConfig(j.config)
      const touchedThreshold = "lowBalanceThreshold" in patch
      if (touchedThreshold) setThreshold(j.config.lowBalanceThreshold == null ? "" : String(j.config.lowBalanceThreshold))
      toast.success(okMsg)
      // Readiness depends on the transport mode; re-read env status and gating from the server.
      await loadConfig({ keepThreshold: !touchedThreshold })
    } catch (e) { toast.error(errMsg(e)) } finally { actionInFlight.current = false; setBusy(null) }
  }

  async function checkStatus(r: Row) {
    setBusy(`check-${r.id}`)
    try {
      const j = await authed("/api/admin/hubtel-cs/check-status", { method: "POST", body: JSON.stringify({ ref: r.client_reference }) })
      if (j.ok) toast.success(j.message ?? "Status checked"); else toast.error(j.message ?? "Status check failed")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(null); await refreshLists() }
  }

  async function confirmResolve() {
    if (!resolving) return
    const { row, outcome } = resolving
    const trimmed = note.trim()
    if (!trimmed || trimmed.length > NOTE_MAX) return
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy("resolve")
    try {
      const j = await authed("/api/admin/hubtel-cs/resolve", { method: "POST", body: JSON.stringify({ ref: row.client_reference, outcome, note: trimmed }) })
      toast.success(j.message ?? "Resolved")
      setResolving(null)
    } catch (e) { toast.error(errMsg(e)) } finally { actionInFlight.current = false; setBusy(null); await refreshLists() }
  }

  async function confirmRefund() {
    if (!refunding) return
    const row = refunding
    const force = !!row.resolved_by
    if (force && !refundAck) return
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy("refund")
    try {
      const j = await authed("/api/admin/hubtel-cs/refund", { method: "POST", body: JSON.stringify({ ref: row.client_reference, ...(force ? { force: true } : {}) }) })
      setBanner({ ok: true, text: `${row.client_reference}: ${j.message}` })
      toast.success("Refund processed")
      setRefunding(null)
    } catch (e) {
      // Non-2xx carries the server's message (e.g. 409 "Refund outcome UNKNOWN ... check the wallet"): show verbatim and persistently.
      setBanner({ ok: false, text: `${row.client_reference}: ${errMsg(e)}` })
      toast.error(errMsg(e))
      setRefunding(null)
    } finally { actionInFlight.current = false; setBusy(null); await refreshLists() }
  }

  const testAmount = Number(test.amount)
  const testAmountValid = test.amount.trim() !== "" && Number.isFinite(testAmount) && testAmount > 0 && testAmount <= TEST_MAX
  const testSvc = HUBTEL_CS_SERVICES[test.serviceKey]
  const testReady = testAmountValid && test.destination.trim() !== "" && (!testSvc.needsBundle || test.bundle.trim() !== "")

  async function sendTest() {
    if (testInFlight.current || testLock > 0 || !testReady) return
    testInFlight.current = true
    setTestBusy(true); setTestResult(null)
    try {
      const j = await authed("/api/admin/hubtel-cs/test-purchase", {
        method: "POST",
        body: JSON.stringify({
          confirm: true, serviceKey: test.serviceKey, destination: test.destination.trim(), amount: testAmount,
          bundle: test.bundle.trim() || undefined,
        }),
      })
      if (!j?.tx) {
        setTestResult({ kind: "unknown", text: "The response had no transaction details, so the outcome is unknown.", ref: undefined })
        setTestLock(10)
      } else {
        setTestResult({ kind: "ok", text: `Test sent: state is ${j.tx.state ?? "unknown"}`, ref: j.tx.client_reference })
        toast.success("Test purchase sent")
      }
    } catch (e) {
      // Only an explicit 4xx (validation, disabled, duplicate, auth) proves nothing was sent. Anything else
      // (network error, 5xx incl. 502/504, non-JSON gateway page, timeout) leaves the outcome unknown.
      const explicit = e instanceof ApiError && e.status >= 400 && e.status < 500
      if (explicit) {
        setTestResult({ kind: "error", text: errMsg(e) })
      } else {
        const m = /reference ([A-Za-z0-9_-]+)/.exec(errMsg(e))
        const bodyRef = e instanceof ApiError && e.body && typeof e.body === "object" ? (e.body as { reference?: unknown }).reference : undefined
        setTestResult({ kind: "unknown", text: errMsg(e), ref: typeof bodyRef === "string" ? bodyRef : m?.[1] })
        setTestLock(10)
      }
      toast.error(errMsg(e))
    } finally {
      testInFlight.current = false
      setTestBusy(false)
      await refreshLists()
    }
  }

  const anyBusy = busy !== null
  const rowBusy = anyBusy || loading
  const needsAck = !!resolving && resolving.row.state !== "needs_review"
  const refundProv = refunding?.resolved_by ?? null

  return (
    <DashboardLayout>
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <PageHeaderBanner title="Hubtel Commission Services" subtitle="Airtime, data and utility bills through Hubtel, with commission earned on every transaction.">
          <Button variant="secondary" size="sm" onClick={reloadAll} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
        </PageHeaderBanner>

        {config?.paused && (
          <Card className="border-amber-300 bg-amber-50">
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-semibold text-amber-900">Paused: new Hubtel orders are blocked</div>
                <div className="text-sm text-amber-800">{config.pausedReason ?? "No reason recorded"} · since {when(config.pausedAt)}. The Disbursement float is shared with Hubtel SMS: top it up before resuming.</div>
              </div>
              <Button disabled={anyBusy} onClick={() => patchConfig({ paused: false }, "Resumed")}>Resume</Button>
            </CardContent>
          </Card>
        )}

        {banner && (
          <Card className={banner.ok ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}>
            <CardContent className="flex items-start justify-between gap-3 p-4">
              <div className={`text-sm ${banner.ok ? "text-emerald-900" : "text-red-900"}`}>{banner.text}</div>
              <Button size="sm" variant="ghost" onClick={() => setBanner(null)}>Dismiss</Button>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Stat label="Transactions" value={stats ? String(stats.total) : "—"} hint={stats ? `${stats.fulfilled} fulfilled` : undefined} />
          <Stat label="In flight" value={stats ? String(stats.in_flight) : "—"} hint="created or pending" />
          <Stat label="Commission earned" value={stats ? money(stats.commission_earned, 4) : "—"} hint="fulfilled transactions" tone="text-emerald-600" />
          <Stat label="Failed / needs review" value={stats ? String(stats.needs_review + stats.failed) : "—"} hint={stats ? `${stats.needs_review} review · ${stats.failed} failed` : undefined} />
        </div>

        <Tabs defaultValue="settings">
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="transactions">Transactions</TabsTrigger>
            <TabsTrigger value="review">Review Queue{reviewList.total ? ` (${reviewList.total})` : ""}</TabsTrigger>
          </TabsList>

          <TabsContent value="settings" className="mt-4">
            {configError && !config && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900">
                Could not load settings: {configError}
                <Button size="sm" variant="outline" className="ml-3" onClick={() => { void loadConfig() }}>Retry</Button>
              </div>
            )}
            {config && (
              <div className="grid gap-4 lg:grid-cols-3">
                <Card>
                  <CardHeader>
                    <CardTitle>Feature gates</CardTitle>
                    <CardDescription>The master switch ships OFF. Nothing customer-facing uses Hubtel until a product phase wires it in.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
                      <div>
                        <div className="font-medium">Commission Services enabled</div>
                        <div className="text-xs text-muted-foreground">Master switch{!config.enabled && env && !env.ready ? " (blocked: environment not ready)" : ""}</div>
                      </div>
                      <Switch aria-label="Commission Services master switch" checked={config.enabled} disabled={anyBusy || (!config.enabled && !!env && !env.ready)}
                        onCheckedChange={v => patchConfig({ enabled: v }, v ? "Enabled" : "Disabled")} />
                    </div>
                    <div className="text-sm font-medium">Services</div>
                    {services.map(s => (
                      <div key={s.key} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                        <div>
                          <div className="font-medium">{s.label}</div>
                          {s.key === "bill_telecel_broadband" && <div className="text-xs text-muted-foreground">Off by default until verified</div>}
                        </div>
                        <Switch aria-label={`${s.label} enabled`} checked={!!config.services[s.key]} disabled={anyBusy}
                          onCheckedChange={v => patchConfig({ services: { [s.key]: v } }, `${s.label} ${v ? "on" : "off"}`)} />
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <div className="space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>Transport and readiness</CardTitle>
                      <CardDescription>Direct calls Hubtel from Vercel. Relay sends it through the fixed-IP droplet.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Select value={config.mode} disabled={anyBusy} onValueChange={v => patchConfig({ mode: v }, "Transport updated")}>
                        <SelectTrigger aria-label="Transport mode"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="direct">Direct (Vercel)</SelectItem>
                          <SelectItem value="relay">Via relay droplet</SelectItem>
                        </SelectContent>
                      </Select>
                      <div className="text-sm font-medium">Readiness checklist</div>
                      {env?.ready ? (
                        <Badge className="bg-emerald-100 text-emerald-700">All required environment variables are set</Badge>
                      ) : (
                        <div className="space-y-1 text-sm text-amber-700">
                          <div>Missing environment variables:</div>
                          <ul className="list-disc pl-5 font-mono text-xs">
                            {(env?.missing ?? []).map(m => <li key={m}>{m}</li>)}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Float</CardTitle>
                      <CardDescription>The Disbursement float is shared with Hubtel SMS. A 4075 response pauses this service automatically.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="text-sm">Low-balance alert threshold (GHS)</div>
                      <div className="flex gap-2">
                        <Input aria-label="Low-balance alert threshold in GHS" inputMode="decimal" placeholder="e.g. 200 (blank = off)" value={threshold} onChange={e => setThreshold(e.target.value)} />
                        <Button disabled={anyBusy} onClick={() => {
                          const t = threshold.trim()
                          const n = Number(t)
                          if (t !== "" && (!Number.isFinite(n) || n <= 0)) { toast.error("Threshold must be a positive number, or blank to turn off"); return }
                          void patchConfig({ lowBalanceThreshold: t === "" ? null : n }, "Threshold saved")
                        }}>Save</Button>
                      </div>
                      {config.paused && <Button variant="outline" className="w-full" disabled={anyBusy} onClick={() => patchConfig({ paused: false }, "Resumed")}>Resume (clear pause)</Button>}
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>Live test</CardTitle>
                    <CardDescription>Sends a REAL Hubtel purchase (max GHS {TEST_MAX}). The master switch must be on.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Select value={test.serviceKey} onValueChange={v => setTest(t => ({ ...t, serviceKey: v as HubtelCsServiceKey }))}>
                      <SelectTrigger aria-label="Test purchase service"><SelectValue /></SelectTrigger>
                      <SelectContent>{services.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
                    </Select>
                    <Input aria-label="Test destination number" placeholder="Destination (e.g. 233246912184)" value={test.destination} onChange={e => setTest(t => ({ ...t, destination: e.target.value }))} />
                    <div>
                      <Input aria-label="Test amount in GHS" inputMode="decimal" placeholder={`Amount (max ${TEST_MAX})`} value={test.amount} onChange={e => setTest(t => ({ ...t, amount: e.target.value }))} />
                      {!testAmountValid && <div className="mt-1 text-xs text-red-600">Enter an amount above 0 and at most GHS {TEST_MAX}</div>}
                    </div>
                    {testSvc.needsBundle && (
                      <Input aria-label="Test bundle or meter number" placeholder="Bundle value / meter number (exactly as Hubtel returns it)" value={test.bundle} onChange={e => setTest(t => ({ ...t, bundle: e.target.value }))} />
                    )}
                    <Button className="w-full" disabled={testBusy || testLock > 0 || !testReady} onClick={sendTest}>{testBusy ? "Sending..." : testLock > 0 ? `Locked: check Transactions (${testLock}s)` : "Send test purchase"}</Button>
                    {testResult && (
                      <div className={`rounded-xl border p-3 text-sm ${testResult.kind === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : testResult.kind === "unknown" ? "border-red-500 bg-red-100 font-semibold text-red-900" : "border-red-300 bg-red-50 text-red-900"}`}>
                        {testResult.kind === "unknown" && <div className="mb-1 text-base">Outcome unknown: do NOT retry. Check the Transactions tab before sending another.</div>}
                        <div>{testResult.text}</div>
                        {testResult.ref && <div className="mt-1 break-all font-mono text-xs">Client reference: {testResult.ref}</div>}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          <TabsContent value="transactions" className="mt-4 space-y-4">
            <Card>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row">
                <form className="flex flex-1 gap-2" onSubmit={e => { e.preventDefault(); setQ(qInput) }}>
                  <Input aria-label="Search by phone, reference or Hubtel id" placeholder="Search phone, reference or Hubtel id" value={qInput} maxLength={100} onChange={e => setQInput(e.target.value)} />
                  <Button type="submit" variant="outline" aria-label="Search"><Search className="h-4 w-4" /></Button>
                </form>
                <Select value={filter} onValueChange={setFilter}>
                  <SelectTrigger className="sm:w-56" aria-label="Filter by state"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="created">Created</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="fulfilled">Fulfilled</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                    <SelectItem value="needs_review">Needs review</SelectItem>
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
            <Pager listing={txList} loading={loading} onPage={o => { void loadList("transactions", o) }} />
            {txList.rows.length === 0 && !loading && <div className="rounded-xl border p-8 text-center text-muted-foreground">No Hubtel transactions found.</div>}
            <div className="space-y-3">
              {txList.rows.map(r => <TxRow key={r.id} r={r} busy={rowBusy} onCheck={checkStatus}
                onResolve={() => {}} onRefund={() => {}} />)}
            </div>
          </TabsContent>

          <TabsContent value="review" className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">Needs-review and failed transactions. Nothing here is refunded or resent automatically; refunds are manual only.</p>
            <Pager listing={reviewList} loading={loading} onPage={o => { void loadList("review", o) }} />
            {reviewList.rows.length === 0 && !loading && <div className="rounded-xl border p-8 text-center text-muted-foreground">Nothing needs attention.</div>}
            {reviewList.rows.map(r => (
              <TxRow key={r.id} r={r} review busy={rowBusy} onCheck={checkStatus}
                onResolve={(row, outcome) => { setNote(""); setAck(false); setResolving({ row, outcome }) }}
                onRefund={row => { setRefundAck(false); setRefunding(row) }} />
            ))}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={!!resolving} onOpenChange={o => { if (!o && busy !== "resolve") setResolving(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as {resolving?.outcome === "fulfilled" ? "delivered" : "failed"}</DialogTitle>
            <DialogDescription>
              Record what you confirmed with Hubtel. This is audit-logged and shown on the row.
              {resolving && <span className="mt-1 block break-all font-mono text-xs">{resolving.row.client_reference}</span>}
            </DialogDescription>
          </DialogHeader>
          {needsAck && resolving && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <input type="checkbox" className="mt-1" checked={ack} onChange={e => setAck(e.target.checked)} />
              <span>This row is already <b>{resolving.row.state}</b>. I understand I am overriding it to <b>{resolving.outcome}</b>.</span>
            </label>
          )}
          <div>
            <Textarea aria-label="Resolution note" placeholder="Note (required)" maxLength={NOTE_MAX + 50} value={note} onChange={e => setNote(e.target.value)} />
            <div className={`mt-1 text-right text-xs ${note.trim().length > NOTE_MAX ? "text-red-600" : "text-muted-foreground"}`}>{note.trim().length}/{NOTE_MAX}</div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy === "resolve"} onClick={() => setResolving(null)}>Cancel</Button>
            <Button disabled={!note.trim() || note.trim().length > NOTE_MAX || (needsAck && !ack) || anyBusy} onClick={confirmResolve}>
              {busy === "resolve" ? "Saving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!refunding} onOpenChange={o => { if (!o && busy !== "refund") setRefunding(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refund to wallet</DialogTitle>
            <DialogDescription>
              Refund {refunding ? money(refunding.amount) : ""} to the customer&apos;s wallet. This is manual, one-time and cannot be repeated.
              {refunding && <span className="mt-1 block break-all font-mono text-xs">{refunding.client_reference}</span>}
            </DialogDescription>
          </DialogHeader>
          {refundProv && refunding && (
            <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-semibold">This row was marked failed by an admin, not by Hubtel.</div>
              <div>Resolved by: <span className="font-mono text-xs">{refundProv}</span></div>
              <div>Note: {refunding.resolution_note ?? "no note"}</div>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={refundAck} onChange={e => setRefundAck(e.target.checked)} />
                <span>I have confirmed with Hubtel that this purchase did not go through, and want to refund anyway.</span>
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy === "refund"} onClick={() => setRefunding(null)}>Cancel</Button>
            <Button disabled={anyBusy || (!!refundProv && !refundAck)} onClick={confirmRefund}>{busy === "refund" ? "Refunding..." : "Refund"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
