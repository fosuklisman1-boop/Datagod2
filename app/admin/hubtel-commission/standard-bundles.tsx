"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { toast } from "sonner"
import { RefreshCw, Search } from "lucide-react"
import { BUNDLE_NETWORKS, type BundleNetwork } from "@/lib/standard-bundles/categories"
import { isValidReferenceNumber, validateBundlesPatch, type BundlesConfig } from "@/lib/standard-bundles/config"

export type Authed = (path: string, init?: RequestInit) => Promise<any>

const NOTE_MAX = 500
const PAGE_SIZE = 25
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Request failed")
const money = (n: number | null | undefined, dp = 2) => (n === null || n === undefined ? "-" : `GHS ${Number(n).toFixed(dp)}`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }) : "-")
const NETWORK_LABEL: Record<BundleNetwork, string> = { MTN: "MTN", TELECEL: "Telecel", AT: "AirtelTigo" }

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-blue-100 text-blue-700",
  processing: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  refunded: "bg-slate-100 text-slate-700",
  paid: "bg-emerald-100 text-emerald-700",
  unpaid: "bg-slate-100 text-slate-700",
}
const Pill = ({ value, prefix }: { value: string; prefix?: string }) => (
  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[value] ?? "bg-slate-100 text-slate-700"}`}>{prefix}{value}</span>
)

// ---------------------------------------------------------------------------------------------
// Settings card
// ---------------------------------------------------------------------------------------------

export function BundlesSettingsCard({ authed }: { authed: Authed }) {
  const [cfg, setCfg] = useState<BundlesConfig | null>(null)
  const [cats, setCats] = useState<Record<string, string[]>>({})
  const [refs, setRefs] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const apply = (j: any) => {
    setCfg(j.config); setCats(j.categories ?? {})
    setRefs(Object.fromEntries(BUNDLE_NETWORKS.map(n => [n, j.config.networks[n].referenceNumber])))
  }
  const load = useCallback(async () => {
    try { apply(await authed("/api/admin/standard-bundles/config")); setError(null) } catch (e) { setError(errMsg(e)) }
  }, [authed])
  useEffect(() => { void load() }, [load])

  async function save(patch: object, okMsg = "Saved") {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    try { apply(await authed("/api/admin/standard-bundles/config", { method: "POST", body: JSON.stringify(patch) })); toast.success(okMsg) }
    catch (e) { toast.error(errMsg(e)) } finally { inFlight.current = false; setBusy(false) }
  }
  const netPatch = (n: BundleNetwork, over: Partial<BundlesConfig["networks"][BundleNetwork]>) => {
    const cur = cfg!.networks[n]
    return { networks: { [n]: { enabled: cur.enabled, hiddenCategories: cur.hiddenCategories, referenceNumber: cur.referenceNumber, ...over } } }
  }

  return (
    <Card className="lg:col-span-3">
      <CardHeader>
        <CardTitle>Standard Bundles</CardTitle>
        <CardDescription>Wallet-paid Hubtel data bundles. Needs the Commission Services master switch and the matching data service switch above.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && !cfg && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            Could not load Standard Bundles settings: {error}
            <Button size="sm" variant="outline" className="ml-3" onClick={() => { void load() }}>Retry</Button>
          </div>
        )}
        {cfg && (
          <>
            <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
              <div>
                <div className="font-medium">Standard Bundles enabled</div>
                <div className="text-xs text-muted-foreground">Master switch for the customer page</div>
              </div>
              <Switch aria-label="Standard Bundles master switch" checked={cfg.enabled} disabled={busy}
                onCheckedChange={v => save({ enabled: v }, v ? "Enabled" : "Disabled")} />
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              {BUNDLE_NETWORKS.map(n => {
                const s = cfg.networks[n]
                const refDirty = refs[n] !== s.referenceNumber
                const refValid = isValidReferenceNumber(refs[n])
                return (
                  <div key={n} className="space-y-3 rounded-xl border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium">{NETWORK_LABEL[n]}</div>
                      <Switch aria-label={`${NETWORK_LABEL[n]} bundles enabled`} checked={s.enabled} disabled={busy}
                        onCheckedChange={v => save(netPatch(n, { enabled: v }), `${NETWORK_LABEL[n]} ${v ? "on" : "off"}`)} />
                    </div>
                    <div>
                      <div className="mb-1 text-xs text-muted-foreground">Catalog reference number (233XXXXXXXXX)</div>
                      <div className="flex gap-2">
                        <Input aria-label={`${NETWORK_LABEL[n]} catalog reference number`} inputMode="numeric" value={refs[n] ?? ""} maxLength={12}
                          onChange={e => setRefs(r => ({ ...r, [n]: e.target.value.trim() }))} />
                        <Button disabled={busy || !refDirty || !refValid} onClick={() => save(netPatch(n, { referenceNumber: refs[n] }), "Reference number saved")}>Save</Button>
                      </div>
                      {!refValid && <div className="mt-1 text-xs text-red-600">Must be a valid Ghana mobile number like 233246912184</div>}
                    </div>
                    <div>
                      <div className="mb-1 text-xs text-muted-foreground">Categories (tap to hide or show)</div>
                      <div className="flex flex-wrap gap-2">
                        {(cats[n] ?? []).map(c => {
                          const hidden = s.hiddenCategories.includes(c)
                          return (
                            <button key={c} type="button" disabled={busy} aria-pressed={!hidden}
                              className={`rounded-full border px-3 py-1 text-xs font-medium ${hidden ? "border-dashed text-muted-foreground line-through" : "bg-primary/10 text-primary"}`}
                              onClick={() => save(netPatch(n, { hiddenCategories: hidden ? s.hiddenCategories.filter(x => x !== c) : [...s.hiddenCategories, c] }), hidden ? `${c} shown` : `${c} hidden`)}>
                              {c}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            <SpecialBundlesSection special={cfg.special} busy={busy} onSave={save} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

// Special Bundles (MTN): the dashboard-only "N x the unit bundle" category. Ships off.
// The config RPC replaces `special` whole, so every save sends all three fields.
function SpecialBundlesSection({ special, busy, onSave }: {
  special: BundlesConfig["special"]; busy: boolean; onSave: (patch: object, okMsg?: string) => Promise<void>
}) {
  const [multiples, setMultiples] = useState(special.multiples.join(", "))
  const [unit, setUnit] = useState(String(special.unitAmount))
  // Re-sync the drafts whenever the saved config changes.
  useEffect(() => { setMultiples(special.multiples.join(", ")); setUnit(String(special.unitAmount)) }, [special])

  const parts = multiples.split(",").map(s => s.trim()).filter(Boolean)
  const parsedMultiples = parts.map(p => (/^\d+$/.test(p) ? Number(p) : NaN))
  const parsedUnit = unit.trim() === "" ? NaN : Number(unit)
  const draft = { enabled: special.enabled, multiples: parsedMultiples, unitAmount: parsedUnit }
  const check = validateBundlesPatch({ special: draft })
  const dirty = !check.ok || JSON.stringify(check.patch.special) !== JSON.stringify(special)

  return (
    <div className="space-y-3 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">Special Bundles (MTN)</div>
          <div className="text-xs text-muted-foreground">Dashboard only. A &quot;Special Bundles&quot; category of multiples of the unit bundle, shown first for MTN.</div>
        </div>
        <Switch aria-label="Special Bundles enabled" checked={special.enabled} disabled={busy}
          onCheckedChange={v => onSave({ special: { enabled: v, multiples: special.multiples, unitAmount: special.unitAmount } }, v ? "Special Bundles on" : "Special Bundles off")} />
      </div>
      <div className="grid gap-3 lg:grid-cols-[2fr_1fr_auto] lg:items-end">
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Multiples (comma separated, 1 to 10 whole numbers from 1 to 50)</div>
          <Input aria-label="Special Bundles multiples" value={multiples} inputMode="numeric" onChange={e => setMultiples(e.target.value)} />
        </div>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Unit amount (GHS)</div>
          <Input aria-label="Special Bundles unit amount" value={unit} inputMode="decimal" onChange={e => setUnit(e.target.value)} />
        </div>
        <Button disabled={busy || !check.ok || !dirty}
          onClick={() => { if (check.ok && check.patch.special) void onSave({ special: check.patch.special }, "Special Bundles saved") }}>Save</Button>
      </div>
      {!check.ok && <div className="text-xs text-red-600">{check.error}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Orders tab
// ---------------------------------------------------------------------------------------------

type RefundInfo = { action: "blocked"; reason: string; reviewQueue?: boolean } | { action: "direct"; releaseStuck: boolean } | null
type OrderRow = {
  id: string; reference_code: string; network: BundleNetwork; bundle_display: string; bundle_category: string; beneficiary_phone: string
  amount: number; paid_amount?: number | null; status: string; payment_status: string; hubtel_client_reference: string | null; commission: number | null
  failure_reason: string | null; notes: string | null; created_at: string; updated_at: string
  channel?: string; channel_label?: string | null; shop_name?: string | null; buyer_phone?: string | null
  purchaser: string; stuck_claim: boolean; has_ledger: boolean | null; refund: RefundInfo; can_retry?: boolean; can_dispatch?: boolean
}

export function BundlesOrdersTab({ authed, onReviewQueue }: { authed: Authed; onReviewQueue: () => void }) {
  const [rows, setRows] = useState<OrderRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [stats, setStats] = useState<Record<string, number> | null>(null)
  const [loading, setLoading] = useState(true)
  const [qInput, setQInput] = useState("")
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const [network, setNetwork] = useState("all")
  const [channel, setChannel] = useState("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)
  const seq = useRef(0)
  const [refunding, setRefunding] = useState<OrderRow | null>(null)
  const [note, setNote] = useState("")
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async (off: number) => {
    const id = ++seq.current
    setLoading(true)
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(off), stats: "1" })
    if (q.trim()) p.set("q", q.trim())
    if (status !== "all") p.set("status", status)
    if (network !== "all") p.set("network", network)
    if (channel !== "all") p.set("channel", channel)
    if (from) p.set("from", from)
    if (to) p.set("to", to)
    try {
      const j = await authed(`/api/admin/standard-bundles/orders?${p}`)
      if (id !== seq.current) return
      setRows(j.rows ?? []); setTotal(j.total ?? 0); setOffset(off); setStats(j.stats ?? null)
    } catch (e) {
      if (id === seq.current) toast.error(`Standard Bundles: ${errMsg(e)}`)
    } finally { if (id === seq.current) setLoading(false) }
  }, [authed, q, status, network, channel, from, to])
  useEffect(() => { void load(0) }, [load])

  async function sync(r: OrderRow) {
    if (inFlight.current || !r.hubtel_client_reference) return
    inFlight.current = true; setBusy(`sync-${r.id}`)
    try {
      const j = await authed("/api/admin/hubtel-cs/check-status", { method: "POST", body: JSON.stringify({ ref: r.hubtel_client_reference }) })
      if (j.ok) toast.success(j.message ?? "Status checked"); else toast.error(j.message ?? "Status check failed")
    } catch (e) { toast.error(errMsg(e)) } finally { inFlight.current = false; setBusy(null); await load(offset) }
  }

  async function retry(r: OrderRow) {
    if (inFlight.current) return
    if (!window.confirm("Resend this order to Hubtel? The customer's data is only sent if Hubtel accepts it.")) return
    inFlight.current = true; setBusy(`retry-${r.id}`)
    try {
      const j = await authed("/api/admin/standard-bundles/retry", { method: "POST", body: JSON.stringify({ orderId: r.id }) })
      setBanner({ ok: !!j.ok, text: `${r.reference_code}: ${j.message}` })
      if (j.ok) toast.success(j.message ?? "Retried"); else toast.error(j.message ?? "Not sent")
    } catch (e) {
      // Non-2xx (409 conflict, 500 could not restore) carries the server's message: show it persistently.
      setBanner({ ok: false, text: `${r.reference_code}: ${errMsg(e)}` }); toast.error(errMsg(e))
    } finally { inFlight.current = false; setBusy(null); await load(offset) }
  }

  async function dispatch(r: OrderRow) {
    if (inFlight.current) return
    if (!window.confirm("Send this paid order to Hubtel now? It never reached Hubtel. The customer's data is only sent if Hubtel accepts it.")) return
    inFlight.current = true; setBusy(`dispatch-${r.id}`)
    try {
      const j = await authed("/api/admin/standard-bundles/dispatch", { method: "POST", body: JSON.stringify({ orderId: r.id }) })
      setBanner({ ok: !!j.ok, text: `${r.reference_code}: ${j.message}` })
      if (j.ok) toast.success(j.message ?? "Dispatched"); else toast.error(j.message ?? "Not sent")
    } catch (e) {
      // Non-2xx (409 conflict, 500 could not restore) carries the server's message: show it persistently.
      setBanner({ ok: false, text: `${r.reference_code}: ${errMsg(e)}` }); toast.error(errMsg(e))
    } finally { inFlight.current = false; setBusy(null); await load(offset) }
  }

  async function confirmRefund() {
    if (!refunding) return
    const trimmed = note.trim()
    if (!trimmed || trimmed.length > NOTE_MAX || inFlight.current) return
    inFlight.current = true; setBusy("refund")
    const r = refunding
    try {
      const j = await authed("/api/admin/standard-bundles/refund", { method: "POST", body: JSON.stringify({ orderId: r.id, note: trimmed }) })
      setBanner({ ok: true, text: `${r.reference_code}: ${j.message}` }); toast.success("Refund processed")
    } catch (e) {
      // Non-2xx carries the server's message (e.g. outcome UNKNOWN): show verbatim and persistently.
      setBanner({ ok: false, text: `${r.reference_code}: ${errMsg(e)}` }); toast.error(errMsg(e))
    } finally { inFlight.current = false; setBusy(null); setRefunding(null); await load(offset) }
  }

  const anyBusy = busy !== null || loading
  return (
    <div className="space-y-4">
      {banner && (
        <Card className={banner.ok ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}>
          <CardContent className="flex items-start justify-between gap-3 p-4">
            <div className={`text-sm ${banner.ok ? "text-emerald-900" : "text-red-900"}`}>{banner.text}</div>
            <Button size="sm" variant="ghost" onClick={() => setBanner(null)}>Dismiss</Button>
          </CardContent>
        </Card>
      )}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {["pending", "processing", "completed", "failed", "refunded"].map(s => (
            <Card key={s}><CardContent className="p-3">
              <div className="text-xs capitalize text-muted-foreground">{s}</div>
              <div className="text-xl font-semibold">{stats[s] ?? 0}</div>
            </CardContent></Card>
          ))}
        </div>
      )}
      <Card>
        <CardContent className="grid gap-3 p-4 lg:grid-cols-[1fr_auto_auto_auto_auto_auto]">
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setQ(qInput) }}>
            <Input aria-label="Search by reference or phone" placeholder="Search reference, Hubtel ref or phone" value={qInput} maxLength={100} onChange={e => setQInput(e.target.value)} />
            <Button type="submit" variant="outline" aria-label="Search"><Search className="h-4 w-4" /></Button>
          </form>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="lg:w-40" aria-label="Filter by status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {["pending", "processing", "completed", "failed", "refunded"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={network} onValueChange={setNetwork}>
            <SelectTrigger className="lg:w-40" aria-label="Filter by network"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All networks</SelectItem>
              {BUNDLE_NETWORKS.map(n => <SelectItem key={n} value={n}>{NETWORK_LABEL[n]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger className="lg:w-36" aria-label="Filter by channel"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              <SelectItem value="dashboard">Dashboard</SelectItem>
              <SelectItem value="storefront">Storefront</SelectItem>
              <SelectItem value="api">API</SelectItem>
              <SelectItem value="bots">Bots</SelectItem>
            </SelectContent>
          </Select>
          <Input type="date" aria-label="From date" value={from} onChange={e => setFrom(e.target.value)} />
          <Input type="date" aria-label="To date" value={to} onChange={e => setTo(e.target.value)} />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{total === 0 ? 0 : offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={loading || offset <= 0} onClick={() => { void load(Math.max(0, offset - PAGE_SIZE)) }}>Previous</Button>
          <Button size="sm" variant="outline" disabled={loading || offset + PAGE_SIZE >= total} onClick={() => { void load(offset + PAGE_SIZE) }}>Next</Button>
        </div>
      </div>
      {rows.length === 0 && !loading && <div className="rounded-xl border p-8 text-center text-muted-foreground">No Standard Bundle orders found.</div>}
      <div className="space-y-3">
        {rows.map(r => {
          // Storefront buyers have no wallet: their refunds go through /admin/refunds (the server refuses a wallet refund).
          const storefront = r.channel === "storefront" || r.channel === "bots"
          const canRefund = !storefront && r.refund?.action === "direct"
          const toReview = !storefront && r.refund?.action === "blocked" && r.refund.reviewQueue
          const storefrontRefund = storefront && r.status !== "refunded" && (r.refund?.action === "direct" || (r.refund?.action === "blocked" && r.refund.reviewQueue))
          return (
            <div key={r.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 lg:flex-row lg:items-center lg:gap-6">
              <div className="lg:w-56">
                <div className="font-medium">{NETWORK_LABEL[r.network]} {r.bundle_display}</div>
                <div className="text-xs text-muted-foreground">{r.bundle_category} · {r.purchaser}</div>
                <div className="text-xs text-muted-foreground">
                  {r.channel === "storefront" ? `Storefront · ${r.shop_name ?? "Unknown shop"}${r.buyer_phone ? ` · ${r.buyer_phone}` : ""}` : r.channel === "bots" ? (r.channel_label ?? "Bot") : r.channel === "api" ? "API" : "Dashboard"}
                </div>
                <div className="font-mono text-xs text-muted-foreground">{r.reference_code}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Beneficiary</div>
                <div className="font-mono text-sm">{r.beneficiary_phone}</div>
                {r.hubtel_client_reference && <div className="break-all font-mono text-xs text-muted-foreground">{r.hubtel_client_reference}</div>}
              </div>
              <div className="lg:w-56">
                <div className="flex flex-wrap gap-1"><Pill value={r.status} /><Pill value={r.payment_status} prefix="pay: " /></div>
                {(r.failure_reason || r.notes) && <div className="mt-1 text-xs text-muted-foreground">{r.failure_reason ?? r.notes}</div>}
                {r.stuck_claim && <div className="mt-1 text-xs font-medium text-amber-700">Stuck dispatch claim (never reached Hubtel)</div>}
              </div>
              <div className="lg:w-36">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">{when(r.created_at)}</div>
                <div className="font-semibold">{money(r.amount)}</div>
                {r.paid_amount != null && <div className="text-xs text-muted-foreground">Paid {money(r.paid_amount)}</div>}
                {r.commission !== null && <div className="text-xs text-emerald-600">+{money(r.commission, 4)} comm.</div>}
              </div>
              <div className="flex flex-wrap gap-2 lg:w-56 lg:justify-end">
                {r.status === "processing" && r.hubtel_client_reference && (
                  <Button size="sm" variant="outline" disabled={anyBusy} onClick={() => sync(r)}>{busy === `sync-${r.id}` ? "Syncing..." : "Sync"}</Button>
                )}
                {r.can_dispatch && (
                  <Button size="sm" variant="outline" disabled={anyBusy} onClick={() => dispatch(r)}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />{busy === `dispatch-${r.id}` ? "Sending..." : "Send to Hubtel"}
                  </Button>
                )}
                {r.can_retry && (
                  <Button size="sm" variant="outline" disabled={anyBusy} onClick={() => retry(r)}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />{busy === `retry-${r.id}` ? "Retrying..." : "Retry"}
                  </Button>
                )}
                {canRefund && <Button size="sm" disabled={anyBusy} onClick={() => { setNote(""); setRefunding(r) }}>Refund (never sent)</Button>}
                {toReview && <Button size="sm" variant="outline" onClick={onReviewQueue}>Open Hubtel review queue</Button>}
                {storefrontRefund && (
                  <Link href="/admin/refunds" className="text-xs font-medium text-primary underline-offset-2 hover:underline">Storefront / bot order — refund from Refunds</Link>
                )}
                {r.refund?.action === "blocked" && !r.refund.reviewQueue && r.status !== "refunded" && <div className="text-xs text-muted-foreground">{r.refund.reason}</div>}
              </div>
            </div>
          )
        })}
      </div>

      <Dialog open={!!refunding} onOpenChange={o => { if (!o && busy !== "refund") setRefunding(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refund never-sent order</DialogTitle>
            <DialogDescription>
              Refund {refunding ? money(refunding.amount) : ""} to the customer&apos;s wallet. This order never reached Hubtel. One-time, audit-logged.
              {refunding && <span className="mt-1 block font-mono text-xs">{refunding.reference_code}</span>}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Textarea aria-label="Refund note" placeholder="Note (required)" maxLength={NOTE_MAX + 50} value={note} onChange={e => setNote(e.target.value)} />
            <div className={`mt-1 text-right text-xs ${note.trim().length > NOTE_MAX ? "text-red-600" : "text-muted-foreground"}`}>{note.trim().length}/{NOTE_MAX}</div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy === "refund"} onClick={() => setRefunding(null)}>Cancel</Button>
            <Button disabled={!note.trim() || note.trim().length > NOTE_MAX || busy !== null} onClick={confirmRefund}>{busy === "refund" ? "Refunding..." : "Refund"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
