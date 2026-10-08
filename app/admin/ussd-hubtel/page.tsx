"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { IMPLEMENTED_SERVICES } from "@/lib/ussd-hubtel/menus"
import {
  BRAND_MAX, DEFAULT_BRAND, WELCOME_MAX, derivedWelcome, validateBrandName, validateWelcome, type HubtelUssdConfig,
} from "@/lib/ussd-hubtel/config"
import type { HubtelTxRow } from "@/lib/ussd-hubtel/types"

type EnvStatus = { webhookSecret: boolean; relayUrl: boolean; relaySecret: boolean; redis?: boolean }
type Counts = { needs_review: number; callback_pending: number; callback_failed: number; awaiting_payment: number }

const SERVICES: { key: keyof HubtelUssdConfig["visibility"]; label: string }[] = [
  { key: "data", label: "Data Bundle" },
  { key: "afa", label: "AFA Registration" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]

type TxFilter = "all" | "attention" | "awaiting_payment" | "fulfilled" | "failed"
const TX_FILTERS: { value: TxFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "awaiting_payment", label: "Awaiting payment" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "failed", label: "Failed" },
]

function matchesFilter(t: HubtelTxRow, f: TxFilter): boolean {
  if (f === "all") return true
  if (f === "attention") return t.state === "needs_review" || t.callback_status === "failed"
  return t.state === f
}

/** Short id with the full value on hover; click copies the full value. */
function IdCell({ value, label }: { value: string | null; label: string }) {
  if (!value) return <span className="text-muted-foreground">-</span>
  const short = value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
  return (
    <button
      type="button"
      title={`${value} (click to copy)`}
      aria-label={`Copy ${label} ${value}`}
      className="font-mono text-xs underline decoration-dotted underline-offset-2 hover:text-foreground"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => toast.success(`${label} copied`), () => toast.error("Copy failed"))
      }}
    >
      {short}
    </button>
  )
}

async function authed(path: string, init?: RequestInit) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("No authentication token available")
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || res.statusText || "Request failed")
  return json
}

// -- Hubtel callback log ---------------------------------------------------------
type CallbackDirection = "inbound_fulfillment" | "outbound_callback" | "status_check"
type CallbackLogSummary = {
  id: string
  created_at: string
  direction: CallbackDirection
  session_id: string | null
  hubtel_order_id: string | null
  outcome: string | null
  ok: boolean | null
  http_status: number | null
}
type CallbackLogFull = CallbackLogSummary & {
  payload: unknown
  raw_body: string | null
  response: unknown
  error: string | null
  source_ip: string | null
}
type DirectionFilter = "all" | CallbackDirection
const DIRECTION_FILTERS: { value: DirectionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "inbound_fulfillment", label: "From Hubtel" },
  { value: "outbound_callback", label: "To Hubtel" },
  { value: "status_check", label: "Status checks" },
]
const PROBLEM_OUTCOMES = new Set(["needs_review", "failed", "parse_error", "invalid_payload", "unknown_session", "error"])
const isProblem = (l: Pick<CallbackLogSummary, "ok" | "outcome">) => l.ok === false || (l.outcome != null && PROBLEM_OUTCOMES.has(l.outcome))
const directionLabel = (d: CallbackDirection) =>
  d === "inbound_fulfillment" ? "From Hubtel" : d === "status_check" ? "Status check" : "To Hubtel"
const shortId = (v: string | null) => (!v ? "-" : v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v)

function prettyJson(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

/** navigator.clipboard with a textarea + execCommand fallback (older browsers / non-secure contexts). */
async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      toast.success("Copied")
      return
    }
  } catch { /* fall through to the fallback */ }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    if (ok) toast.success("Copied")
    else toast.error("Copy failed")
  } catch {
    toast.error("Copy failed")
  }
}

function CallbackLogCard() {
  const [direction, setDirection] = useState<DirectionFilter>("all")
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [logs, setLogs] = useState<CallbackLogSummary[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [tableMissing, setTableMissing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<CallbackLogSummary | null>(null)
  const [detail, setDetail] = useState<CallbackLogFull | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  // Sequence tokens: only the LATEST list request / detail request may update state, so rapid
  // filter toggles or clicking row A then B never show stale data.
  const listSeq = useRef(0)
  const detailSeq = useRef(0)

  // `cursor` is the opaque nextBefore ("<created_at>|<id>") from the previous page, or null.
  const fetchPage = useCallback(async (cursor: string | null) => {
    const params = new URLSearchParams({ limit: "50" })
    if (direction !== "all") params.set("direction", direction)
    if (problemsOnly) params.set("problemsOnly", "1")
    if (cursor) params.set("before", cursor)
    const seq = ++listSeq.current
    setLoading(true)
    setLoadError(null)
    try {
      const res = await authed(`/api/admin/ussd-hubtel/callback-logs?${params.toString()}`)
      if (seq !== listSeq.current) return
      const page: CallbackLogSummary[] = Array.isArray(res.logs) ? res.logs : []
      setLogs(prev => (cursor ? [...prev, ...page] : page))
      setNextBefore(typeof res.nextBefore === "string" ? res.nextBefore : null)
      setTableMissing(res.tableMissing === true)
    } catch (e: any) {
      if (seq !== listSeq.current) return
      setLoadError(e.message || "Failed to load callback log")
      toast.error(e.message || "Failed to load callback log")
    } finally {
      if (seq === listSeq.current) setLoading(false)
    }
  }, [direction, problemsOnly])
  useEffect(() => { fetchPage(null) }, [fetchPage])

  const open = async (l: CallbackLogSummary) => {
    const seq = ++detailSeq.current
    setSelected(l)
    setDetail(null)
    setDetailError(null)
    try {
      const res = await authed(`/api/admin/ussd-hubtel/callback-logs/${encodeURIComponent(l.id)}`)
      if (seq !== detailSeq.current) return
      // Belt and braces: never show a body that belongs to another row.
      if (res.log && res.log.id !== l.id) return
      setDetail(res.log ?? null)
      if (!res.log) setDetailError("Not found")
    } catch (e: any) {
      if (seq !== detailSeq.current) return
      setDetailError(e.message || "Failed to load entry")
    }
  }
  const closeDetail = () => {
    detailSeq.current++ // drop any in-flight detail response
    setSelected(null); setDetail(null); setDetailError(null)
  }

  const payloadText = detail ? (detail.payload != null ? prettyJson(detail.payload) : detail.raw_body ?? "") : ""

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Hubtel callbacks</CardTitle>
          <CardDescription>
            Payment confirmations from Hubtel and the success callbacks we send back. Kept for 30 days. Click a row for the full payload.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {DIRECTION_FILTERS.map(f => (
            <Button key={f.value} size="sm" variant={direction === f.value ? "default" : "outline"} aria-pressed={direction === f.value}
              onClick={() => setDirection(f.value)}>{f.label}</Button>
          ))}
          <Button size="sm" variant={problemsOnly ? "destructive" : "outline"} aria-pressed={problemsOnly}
            onClick={() => setProblemsOnly(p => !p)}>Problems only</Button>
          <Button variant="outline" size="sm" onClick={() => fetchPage(null)} disabled={loading} aria-label="Refresh callback log">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 overflow-x-auto">
        {tableMissing && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Logging starts after migration 0109 is applied (<code>migrations/0109_hubtel_callback_logs.sql</code>).
          </p>
        )}
        {loadError && <p className="text-sm text-destructive">{loadError}</p>}
        <table className="w-full text-sm">
          <thead><tr className="text-left text-muted-foreground">
            <th className="p-2">Time</th><th className="p-2">Direction</th><th className="p-2">Session</th>
            <th className="p-2">Outcome</th><th className="p-2">Status</th>
          </tr></thead>
          <tbody>
            {logs.map(l => (
              // The real control is the <button> in the first cell (keyboard + screen readers);
              // clicking anywhere on the row is a mouse convenience.
              <tr key={l.id} className="cursor-pointer border-t hover:bg-muted/50 focus-within:bg-muted/50" onClick={() => open(l)}>
                <td className="p-2 whitespace-nowrap">
                  <button
                    type="button"
                    className="text-left underline decoration-dotted underline-offset-2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    aria-label={`Open ${directionLabel(l.direction)} log for session ${l.session_id ?? "unknown"}, outcome ${l.outcome ?? "unknown"}`}
                    onClick={e => { e.stopPropagation(); open(l) }}
                  >
                    {new Date(l.created_at).toLocaleString()}
                  </button>
                </td>
                <td className="p-2"><Badge variant="outline">{directionLabel(l.direction)}</Badge></td>
                <td className="p-2 font-mono text-xs" title={l.session_id ?? ""}>{shortId(l.session_id)}</td>
                <td className="p-2"><Badge variant={isProblem(l) ? "destructive" : "secondary"}>{l.outcome ?? "-"}</Badge></td>
                <td className="p-2">{l.http_status ?? "-"}</td>
              </tr>
            ))}
            {logs.length === 0 && !loading && (
              <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">
                {tableMissing ? "No log yet." : problemsOnly || direction !== "all" ? "No entries match this filter." : "No callbacks logged yet."}
              </td></tr>
            )}
            {logs.length === 0 && loading && (
              <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Loading...</td></tr>
            )}
          </tbody>
        </table>
        {nextBefore && (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" disabled={loading} onClick={() => fetchPage(nextBefore)}>
              {loading ? "Loading..." : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={!!selected} onOpenChange={o => { if (!o) closeDetail() }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selected ? directionLabel(selected.direction) : "Callback"}</DialogTitle>
            <DialogDescription>
              {selected ? `${new Date(selected.created_at).toLocaleString()} · outcome ${selected.outcome ?? "-"}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detailError && <p className="text-sm text-destructive">{detailError}</p>}
          {!detail && !detailError && <p className="text-sm text-muted-foreground">Loading...</p>}
          {detail && (
            <div className="space-y-3 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">Session</dt><dd className="break-all font-mono text-xs">{detail.session_id ?? "-"}</dd>
                <dt className="text-muted-foreground">Hubtel order</dt><dd className="break-all font-mono text-xs">{detail.hubtel_order_id ?? "-"}</dd>
                <dt className="text-muted-foreground">Outcome</dt><dd>{detail.outcome ?? "-"}{detail.ok === false ? " (problem)" : ""}</dd>
                <dt className="text-muted-foreground">HTTP status</dt><dd>{detail.http_status ?? "-"}</dd>
                {detail.source_ip && (<><dt className="text-muted-foreground">Source IP</dt><dd className="font-mono text-xs">{detail.source_ip}</dd></>)}
              </dl>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {detail.payload != null ? "Payload" : detail.raw_body != null ? "Raw body (did not parse as JSON)" : "Payload"}
                </div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 font-mono text-xs">
                  {payloadText || "(empty)"}
                </pre>
              </div>
              {(detail.direction === "outbound_callback" || detail.direction === "status_check") && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    {detail.direction === "status_check" ? "Status check response" : "Hubtel response"}
                  </div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 font-mono text-xs">
                    {prettyJson(detail.response) || "(none)"}
                  </pre>
                </div>
              )}
              {detail.error && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Error</div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 font-mono text-xs text-destructive">
                    {detail.error}
                  </pre>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            {detail?.direction === "status_check" && (
              <Button variant="outline" onClick={() => copyText(prettyJson(detail.response))}>Copy response</Button>
            )}
            <Button variant="outline" disabled={!detail} onClick={() => copyText(payloadText)}>Copy payload</Button>
            <Button variant="outline" disabled={!detail} onClick={() => copyText(JSON.stringify(detail, null, 2))}>Copy all (JSON)</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default function AdminUssdHubtelPage() {
  const [config, setConfig] = useState<HubtelUssdConfig | null>(null)
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [txs, setTxs] = useState<HubtelTxRow[]>([])
  const [counts, setCounts] = useState<Counts | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<TxFilter>("all")
  const [resolving, setResolving] = useState<HubtelTxRow | null>(null)
  const [outcome, setOutcome] = useState<"fulfilled" | "not_paid">("fulfilled")
  const [note, setNote] = useState("")
  // Brand name: re-synced from the server value on load / save / reset.
  const [brandDraft, setBrandDraft] = useState("")
  const savedBrand = config?.brandName
  useEffect(() => { if (savedBrand !== undefined) setBrandDraft(savedBrand) }, [savedBrand])
  const brandCheck = validateBrandName(brandDraft)
  const brandUnchanged = brandCheck.ok && brandCheck.value === savedBrand
  // Brand used for live previews: the draft while it is valid, else the saved one.
  const previewBrand = brandCheck.ok ? brandCheck.value : (savedBrand ?? DEFAULT_BRAND)

  // Welcome: the field holds ONLY the custom override; blank means "Welcome to <brand>".
  const [welcomeDraft, setWelcomeDraft] = useState("")
  const savedCustomWelcome = config ? (config.welcomeCustom ? config.welcome : "") : undefined
  useEffect(() => { if (savedCustomWelcome !== undefined) setWelcomeDraft(savedCustomWelcome) }, [savedCustomWelcome])
  const welcomeBlank = welcomeDraft.trim() === ""
  const welcomeCheck = validateWelcome(welcomeDraft)
  const welcomeValid = welcomeBlank || welcomeCheck.ok
  const welcomeUnchanged = welcomeBlank ? savedCustomWelcome === "" : welcomeCheck.ok && welcomeCheck.value === savedCustomWelcome
  const previewWelcome = welcomeBlank ? derivedWelcome(previewBrand) : welcomeDraft.trim()
  // "Not paid" is only possible while no payment is recorded and no callback is due.
  const canMarkNotPaid = (t: HubtelTxRow) => t.paid_at == null && t.callback_status === "not_due"
  const shown = txs.filter(t => matchesFilter(t, filter))

  const load = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([authed("/api/admin/ussd-hubtel/config"), authed("/api/admin/ussd-hubtel/transactions")])
      setConfig(c.config); setEnv(c.env); setTxs(t.transactions); setCounts(t.counts)
    } catch (e: any) { toast.error(e.message || "Failed to load Hubtel USSD") }
  }, [])
  useEffect(() => { load() }, [load])

  const save = async (patch: object, label: string) => {
    setBusy(label)
    try {
      const res = await authed("/api/admin/ussd-hubtel/config", { method: "POST", body: JSON.stringify(patch) })
      setConfig(res.config); toast.success("Saved")
    } catch (e: any) { toast.error(e.message || "Save failed") } finally { setBusy(null) }
  }

  const retry = async (sessionId: string) => {
    setBusy(sessionId)
    try {
      const res = await authed("/api/admin/ussd-hubtel/retry-callback", { method: "POST", body: JSON.stringify({ sessionId }) })
      toast.success(`Callback: ${res.result}`); await load()
    } catch (e: any) { toast.error(e.message || "Retry failed") } finally { setBusy(null) }
  }

  const openResolve = (t: HubtelTxRow) => { setResolving(t); setOutcome("fulfilled"); setNote("") }

  const submitResolve = async () => {
    if (!resolving) return
    setBusy(`resolve:${resolving.session_id}`)
    try {
      const res = await authed("/api/admin/ussd-hubtel/resolve", {
        method: "POST",
        body: JSON.stringify({ sessionId: resolving.session_id, outcome, note }),
      })
      if (res.warning) {
        // The resolution was recorded but the order row was not updated: the admin must check it.
        toast.warning(`Resolved. ${res.callbackNote} ${res.warning}`, { duration: 15000 })
      } else {
        toast.success(`Resolved. ${res.callbackNote}`)
      }
      setResolving(null)
      await load()
    } catch (e: any) { toast.error(e.message || "Resolve failed") } finally { setBusy(null) }
  }

  const envOk =env && env.webhookSecret && env.relayUrl && env.relaySecret

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeaderBanner title="Hubtel USSD" subtitle="One Hubtel code serving the main menu or the shop menu. Configure the channel and watch payments." />

        <Card>
          <CardHeader>
            <CardTitle>Channel</CardTitle>
            <CardDescription>The kill switch ships OFF. Turn it on only after the runbook checks pass.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!config ? <p className="text-sm text-muted-foreground">Loading...</p> : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Hubtel USSD enabled</span>
                  <Switch checked={config.enabled} disabled={busy === "enabled" || (!config.enabled && !envOk)} aria-label="Toggle Hubtel USSD"
                    onCheckedChange={v => save({ enabled: v }, "enabled")} />
                </div>
                {!envOk && <p className="text-xs text-amber-600">Cannot enable until all environment variables below are configured.</p>}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Mode</span>
                  <Select value={config.mode} disabled={busy === "mode"} onValueChange={v => {
                    if (v === config.mode) return
                    const label = v === "shop" ? "Shop USSD" : "Main USSD"
                    const billing = v === "shop"
                      ? " In shop mode callers must enter a shop code first, and each Hubtel session costs that shop ONE session token (billed when the code is accepted, never refunded)."
                      : ""
                    if (!window.confirm(`Switch the Hubtel code to ${label}?${billing} Calls already in progress keep the mode they started with; new dials use ${label}.`)) return
                    save({ mode: v }, "mode")
                  }}>
                    <SelectTrigger className="w-48" aria-label="Hubtel USSD mode"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="main">Main USSD</SelectItem>
                      <SelectItem value="shop">Shop USSD (shop code first)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {config.mode === "shop" && (
                  <p className="text-xs text-muted-foreground">
                    Shop mode: callers enter a shop code first, and each Hubtel session costs that shop one session token (billed once
                    per session, when the code is accepted). Services follow the shop&apos;s catalogue and the toggles below. AFA is not
                    offered in shop mode. Calls already in progress keep the mode they started with.
                  </p>
                )}
                {env && env.redis === false && (
                  <p className="text-xs text-amber-600">
                    Redis (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) is not configured: shop mode cannot be selected in production.
                  </p>
                )}
                <div className="divide-y rounded-lg border">
                  {SERVICES.map(s => {
                    // The shop menu has no AFA: its toggle does nothing in shop mode.
                    const deadInShop = config.mode === "shop" && s.key === "afa"
                    return (
                      <div key={s.key} className="flex items-center justify-between p-3">
                        <span className="text-sm">
                          {s.label}{!IMPLEMENTED_SERVICES[s.key] && <Badge variant="outline" className="ml-2">not built yet</Badge>}
                          {deadInShop && <span className="ml-2 text-xs text-muted-foreground">AFA is not offered in shop mode</span>}
                        </span>
                        <Switch checked={config.visibility[s.key]} disabled={busy === s.key || deadInShop} aria-label={`Toggle ${s.label}`}
                          onCheckedChange={v => save({ visibility: { [s.key]: v } }, s.key)} />
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Brand name</CardTitle>
            <CardDescription>
              The name callers see on the Hubtel screens: the welcome line (unless a custom welcome is set below), the
              exit message (&quot;Thank you for using {previewBrand}.&quot;) and the Check Results &quot;create an
              account&quot; message. SMS texts sent by shared services are not affected. Applies immediately.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!config ? <p className="text-sm text-muted-foreground">Loading...</p> : (
              <>
                <div className="space-y-1">
                  <Input
                    value={brandDraft}
                    onChange={e => setBrandDraft(e.target.value)}
                    maxLength={BRAND_MAX}
                    placeholder={DEFAULT_BRAND}
                    aria-label="Brand name"
                    aria-invalid={!brandCheck.ok}
                    aria-describedby="hubtel-brand-help"
                  />
                  <div id="hubtel-brand-help" className="flex items-start justify-between gap-3 text-xs">
                    <span className={brandCheck.ok ? "text-muted-foreground" : "text-destructive"}>
                      {brandCheck.ok ? "1-30 plain characters (letters, numbers, spaces, basic punctuation), one line." : brandCheck.error}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{brandDraft.length}/{BRAND_MAX}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy === "brand" || !brandCheck.ok || brandUnchanged}
                    onClick={() => { if (brandCheck.ok) save({ brandName: brandCheck.value }, "brand") }}
                  >
                    {busy === "brand" ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === "brand" || (savedBrand === DEFAULT_BRAND && brandDraft === DEFAULT_BRAND)}
                    onClick={() => {
                      // Already the default on the server: just discard the local edit.
                      if (savedBrand === DEFAULT_BRAND) setBrandDraft(DEFAULT_BRAND)
                      else save({ brandName: "" }, "brand")
                    }}
                  >
                    Reset to default
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Welcome message</CardTitle>
            <CardDescription>
              The first line callers see: on the main menu (main mode) and on the shop-code prompt (shop mode). Applies to new dials immediately.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!config ? <p className="text-sm text-muted-foreground">Loading...</p> : (
              <>
                <div className="flex items-center gap-2 text-xs">
                  <Badge variant={config.welcomeCustom ? "default" : "outline"}>{config.welcomeCustom ? "Custom" : "From brand name"}</Badge>
                  <span className="text-muted-foreground">Leave blank to use &apos;{derivedWelcome(previewBrand)}&apos;.</span>
                </div>
                <div className="space-y-1">
                  <Input
                    value={welcomeDraft}
                    onChange={e => setWelcomeDraft(e.target.value)}
                    maxLength={WELCOME_MAX}
                    placeholder={derivedWelcome(previewBrand)}
                    aria-label="Welcome message"
                    aria-invalid={!welcomeValid}
                    aria-describedby="hubtel-welcome-help"
                  />
                  <div id="hubtel-welcome-help" className="flex items-start justify-between gap-3 text-xs">
                    <span className={welcomeValid ? "text-muted-foreground" : "text-destructive"}>
                      {welcomeValid || welcomeCheck.ok
                        ? "1-60 plain characters (letters, numbers, spaces, basic punctuation), one line."
                        : welcomeCheck.error}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{welcomeDraft.length}/{WELCOME_MAX}</span>
                  </div>
                </div>
                <div className="rounded-lg border bg-muted/40 p-3">
                  <div className="mb-1 text-xs text-muted-foreground">Preview</div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-sm">
                    {`${previewWelcome}\n${config.mode === "shop" ? "Enter shop code:" : "1. Buy Data Bundle\n..."}`}
                  </pre>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy === "welcome" || !welcomeValid || welcomeUnchanged}
                    onClick={() => save({ welcome: welcomeBlank ? "" : welcomeDraft.trim() }, "welcome")}
                  >
                    {busy === "welcome" ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === "welcome" || (!config.welcomeCustom && welcomeBlank)}
                    onClick={() => {
                      // Not customised on the server: just discard the local edit.
                      if (!config.welcomeCustom) setWelcomeDraft("")
                      else save({ welcome: "" }, "welcome")
                    }}
                  >
                    Reset to default
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Environment</CardTitle><CardDescription>Secrets live in env vars; this only shows whether they are set.</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {env && ([["HUBTEL_WEBHOOK_SECRET", env.webhookSecret], ["HUBTEL_RELAY_URL", env.relayUrl], ["HUBTEL_RELAY_SECRET", env.relaySecret]] as const).map(([k, ok]) => (
              <Badge key={k} variant={ok ? "default" : "destructive"}>{k}: {ok ? "set" : "missing"}</Badge>
            ))}
            {env && env.redis !== undefined && (
              <Badge variant={env.redis ? "default" : "destructive"} title="Needed for shop mode (token billing guard) and the USSD session store">
                UPSTASH_REDIS (shop mode): {env.redis ? "set" : "missing"}
              </Badge>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Payments</CardTitle>
              {counts && <CardDescription>
                {counts.awaiting_payment} awaiting · {counts.needs_review} need review · {counts.callback_pending} callbacks pending · {counts.callback_failed} callbacks failed
              </CardDescription>}
              <CardDescription className="mt-1 text-xs">
                Shows the 50 most recent sessions plus every row needing attention (needs review or callback failed).
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={filter} onValueChange={v => setFilter(v as TxFilter)}>
                <SelectTrigger className="w-44" aria-label="Filter by state"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TX_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={load} aria-label="Refresh"><RefreshCw className="w-4 h-4" /></Button>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground">
                <th className="p-2">Time</th><th className="p-2">Session</th><th className="p-2">Order</th><th className="p-2">Hubtel order</th>
                <th className="p-2">Platform</th><th className="p-2">Mobile</th><th className="p-2">Expected</th>
                <th className="p-2">Paid</th><th className="p-2">State</th><th className="p-2">Callback</th><th className="p-2" />
              </tr></thead>
              <tbody>
                {shown.map(t => (
                  <tr key={t.session_id} className="border-t">
                    <td className="p-2 whitespace-nowrap">{new Date(t.created_at).toLocaleString()}</td>
                    <td className="p-2"><IdCell value={t.session_id} label="Session id" /></td>
                    <td className="p-2">
                      <div className="text-xs text-muted-foreground">{t.order_table}</div>
                      <IdCell value={t.order_id} label="Order id" />
                    </td>
                    <td className="p-2"><IdCell value={t.hubtel_order_id} label="Hubtel order id" /></td>
                    <td className="p-2">{t.platform}</td>
                    <td className="p-2 whitespace-nowrap">{t.mobile ?? "-"}</td>
                    <td className="p-2">GHS {Number(t.expected_amount).toFixed(2)}</td>
                    <td className="p-2">{t.amount_after_charges != null ? `GHS ${Number(t.amount_after_charges).toFixed(2)}` : "-"}</td>
                    <td className="p-2">
                      <Badge variant={t.state === "needs_review" || t.state === "failed" ? "destructive" : "secondary"}>{t.state}</Badge>
                      {t.state === "needs_review" && t.review_reason && (
                        <div className="mt-1 max-w-[16rem] text-xs text-muted-foreground">Reason: {t.review_reason}</div>
                      )}
                      {t.state === "needs_review" && t.callback_last_error && t.callback_last_error !== t.review_reason && (
                        <div className="mt-1 max-w-[16rem] text-xs text-muted-foreground">{t.callback_last_error}</div>
                      )}
                      {t.resolved_at && (
                        <div className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                          Resolved {new Date(t.resolved_at).toLocaleString()}: {t.resolution_note}
                        </div>
                      )}
                    </td>
                    <td className="p-2" title={t.callback_last_error ?? ""}><Badge variant={t.callback_status === "failed" ? "destructive" : "outline"}>{t.callback_status}</Badge></td>
                    <td className="p-2">
                      <div className="flex flex-col gap-1">
                        {(t.state === "fulfilled" || t.state === "needs_review") && (t.callback_status === "pending" || t.callback_status === "failed") && (
                          <Button size="sm" variant="outline" disabled={busy === t.session_id} onClick={() => retry(t.session_id)}>Retry callback</Button>
                        )}
                        {t.state === "needs_review" && (
                          <Button size="sm" variant="outline" onClick={() => openResolve(t)}>Mark resolved</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">
                    {txs.length === 0 ? "No Hubtel transactions yet." : "No transactions match this filter."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <CallbackLogCard />

        <Dialog open={!!resolving} onOpenChange={open => { if (!open) setResolving(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Mark resolved</DialogTitle>
              <DialogDescription>
                &quot;Fulfilled&quot; means the goods or service were delivered to the customer manually; if a Hubtel
                order id is on record, a success callback will be sent. &quot;Not paid&quot; means Hubtel never took the
                payment (check the Hubtel dashboard). If the customer was charged but the service cannot be delivered,
                arrange a refund with Hubtel directly before resolving. A note is required either way.
              </DialogDescription>
            </DialogHeader>
            {resolving && (
              <div className="space-y-3 text-sm">
                <div className="text-muted-foreground">{resolving.order_table} / {resolving.session_id}</div>
                <Select value={outcome} onValueChange={v => setOutcome(v as "fulfilled" | "not_paid")}>
                  <SelectTrigger aria-label="Outcome"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fulfilled">Fulfilled (delivered manually)</SelectItem>
                    <SelectItem value="not_paid" disabled={!canMarkNotPaid(resolving)}>Not paid (Hubtel never took the payment)</SelectItem>
                  </SelectContent>
                </Select>
                {outcome === "fulfilled" && resolving.callback_status === "not_due" && !resolving.hubtel_order_id && (
                  <p className="text-xs text-amber-600">No Hubtel order id is on record, so no success callback can be sent for this row.</p>
                )}
                <Textarea
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="What you did (5-500 characters)"
                  maxLength={500}
                  aria-label="Resolution note"
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setResolving(null)}>Cancel</Button>
              <Button disabled={note.trim().length < 5 || !!busy?.startsWith("resolve:")} onClick={submitResolve}>Resolve</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
