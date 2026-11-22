"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Copy, Download, FileSpreadsheet, Loader2, RefreshCw, Settings } from "lucide-react"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { useAdminProtected } from "@/hooks/use-admin"
import { BLOCK_SURFACES } from "@/lib/blocked-numbers/types"

type Row = {
  id: string
  phone: string
  status: "blocked" | "allowed" | "expired" | "handled"
  first_blocked_at: string | null
  last_blocked_at: string | null
  attempts: number | null
  providers_rejected: string[] | null
  last_rechecked_at: string | null
  recheck_count: number | null
  allowed_by: string | null
  submitted_to_supplier: string | null
  submitted_at: string | null
  customer_notified_at: string | null
  notes: string | null
  surfaces: string[]
  shopNames: string[]
}

type Stats = {
  open: number
  becameAllowed7d: number
  customersTexted7d: number
  expired: number
  attempts24h: number
  surfaces7d: Array<{ surface: string; count: number }>
  surfaces7dTruncated: boolean
}

type ListPayload = { rows: Row[]; total: number; page: number; pageSize: number; stats: Stats | null; suppliers: string[] }

type AllResult = {
  providers: string[]
  checkoutProviders: string[]
  flipped: number
  failedProviders?: string[]
  recheckFailed?: boolean
  flipFailed?: boolean
  notifyQueued?: boolean
  flippedOutside?: number
  flippedOutsideIds?: string[]
  rows: Array<{
    id: string
    phone: string
    results: Record<string, "allowed" | "refused" | "error">
    allowedByCheckout: boolean
    allowedOutsideCheckout: string[]
  }>
}

const STATUSES = ["blocked", "allowed", "expired", "handled"] as const
const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.style.display = "none"
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}

function ago(iso: string | null): string {
  if (!iso) return "never"
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return "under 1 h ago"
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"
}

const STATUS_STYLE: Record<Row["status"], string> = {
  blocked: "bg-destructive/10 text-destructive border-destructive/30",
  allowed: "bg-success/10 text-success border-success/30",
  expired: "bg-muted text-muted-foreground border-border",
  handled: "bg-primary/10 text-primary border-primary/30",
}

export default function BlockedNumbersPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [data, setData] = useState<ListPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState("")
  const [surface, setSurface] = useState("")
  const [search, setSearch] = useState("")
  const [query, setQuery] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [handleTarget, setHandleTarget] = useState<string[] | null>(null)
  const [note, setNote] = useState("")
  const [supplierOpen, setSupplierOpen] = useState(false)
  const [supplier, setSupplier] = useState("")
  const [mark, setMark] = useState(false)
  const [unsubmitted, setUnsubmitted] = useState(true)
  const allRequestRef = useRef(0)
  const [allOpen, setAllOpen] = useState(false)
  const [allResult, setAllResult] = useState<AllResult | null>(null)

  const filterParams = useMemo(() => {
    const p = new URLSearchParams()
    if (status) p.set("status", status)
    if (surface) p.set("surface", surface)
    if (query) p.set("q", query)
    if (from) p.set("from", new Date(from).toISOString())
    if (to) p.set("to", new Date(`${to}T23:59:59.999`).toISOString())
    return p
  }, [status, surface, query, from, to])

  const load = useCallback(
    async (withStats: boolean) => {
      setLoading(true)
      try {
        const p = new URLSearchParams(filterParams)
        p.set("page", String(page))
        if (withStats) p.set("include_stats", "1")
        const res = await fetch(`/api/admin/blocked-numbers?${p}`, { headers: { Authorization: `Bearer ${await getToken()}` } })
        if (!res.ok) throw new Error("Failed to load")
        const json = (await res.json()) as ListPayload
        setData((prev) => ({ ...json, stats: json.stats ?? prev?.stats ?? null, suppliers: withStats ? json.suppliers : (prev?.suppliers ?? []) }))
        setSelected(new Set())
      } catch {
        toast.error("Failed to load blocked numbers")
      } finally {
        setLoading(false)
      }
    },
    [filterParams, page]
  )

  // Stats ride along with the first page of a filter set; paging does not refetch them.
  useEffect(() => {
    if (isAdmin && !adminLoading) load(page === 1 && !data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, adminLoading, load])

  const post = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || "Request failed")
    return json
  }

  const recheck = async (body: { ids: string[] } | { all: true }) => {
    setBusy("recheck")
    try {
      const j = await post("/api/admin/blocked-numbers/recheck", body)
      toast.success(`Checked ${j.checked}: ${j.allowed} now allowed, ${j.stillBlocked} still blocked${j.unchecked ? `, ${j.unchecked} could not be checked` : ""}`)
      if (j.notifyQueued) toast.success("Ready — customers will be texted now (if texting is on).")
      await load(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Re-check failed")
    } finally {
      setBusy(null)
    }
  }

  const checkAll = async (ids: string[]) => {
    const requestId = ++allRequestRef.current
    setBusy("checkall")
    setAllResult(null)
    setAllOpen(true)
    try {
      const j = (await post("/api/admin/blocked-numbers/check-all", { ids })) as AllResult
      if (requestId !== allRequestRef.current) return // a newer check started; drop this stale answer
      setAllResult(j)
      if (j.flipped > 0) {
        if (j.notifyQueued) toast.success("Ready — customers will be texted now (if texting is on).")
        await load(true)
      }
    } catch (e) {
      if (requestId !== allRequestRef.current) return
      setAllOpen(false)
      toast.error(e instanceof Error ? e.message : "Check failed")
    } finally {
      if (requestId === allRequestRef.current) setBusy(null)
    }
  }

  const copyAllowedBy = async (provider: string) => {
    const phones = (allResult?.rows ?? []).filter((r) => r.results[provider] === "allowed").map((r) => r.phone)
    try {
      await navigator.clipboard.writeText(phones.join("\n"))
      toast.success(`Copied ${phones.length} number(s)`)
    } catch {
      toast.error("Could not copy")
    }
  }

  const reopen = async (id: string) => {
    setBusy(id)
    try {
      await post("/api/admin/blocked-numbers/update", { id, action: "reopen" })
      toast.success("Re-opened")
      await load(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed")
    } finally {
      setBusy(null)
    }
  }

  const submitHandled = async () => {
    if (!handleTarget || !note.trim()) return
    setBusy("handle")
    let ok = 0
    let failed = 0
    for (const id of handleTarget) {
      try {
        await post("/api/admin/blocked-numbers/update", { id, action: "handle", note: note.trim() })
        ok++
      } catch {
        failed++
      }
    }
    setBusy(null)
    setHandleTarget(null)
    setNote("")
    if (ok > 0) toast.success(`Marked ${ok} handled`)
    if (failed > 0) toast.error(`${failed} could not be marked (already allowed or changed)`)
    await load(true)
  }

  const download = async (url: string, fallbackName: string, key: string) => {
    setBusy(key)
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || "Export failed")
      }
      const marked = res.headers.get("X-Marked-Count")
      triggerBlobDownload(await res.blob(), fallbackName)
      if (marked && Number(marked) > 0) toast.success(`Marked ${marked} numbers as submitted`)
      if (res.headers.get("X-Truncated") === "1") {
        toast.warning("Export stopped at 10,000 rows. Run it again (with 'only not yet submitted' on) for the rest.")
      }
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed")
      return false
    } finally {
      setBusy(null)
    }
  }

  const exportReport = () => download(`/api/admin/blocked-numbers/export?${new URLSearchParams({ kind: "report", ...Object.fromEntries(filterParams) })}`, "blocked-numbers-report.xlsx", "report")

  const exportSupplier = async () => {
    const p = new URLSearchParams({ kind: "supplier", supplier })
    if (mark) p.set("mark", "1")
    if (unsubmitted) p.set("unsubmitted", "1")
    const ok = await download(`/api/admin/blocked-numbers/export?${p}`, "blocked-mtn-numbers.xlsx", "supplier")
    if (ok) {
      setSupplierOpen(false)
      if (mark) await load(true)
    }
  }

  if (adminLoading) return null

  const rows = data?.rows ?? []
  const stats = data?.stats
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const tiles: Array<[string, string | number]> = [
    ["Open (blocked)", stats?.open ?? "-"],
    ["Became allowed (7 d)", stats?.becameAllowed7d ?? "-"],
    ["Customers texted (7 d)", stats?.customersTexted7d ?? "-"],
    ["Expired", stats?.expired ?? "-"],
    ["Blocked attempts (24 h)", stats?.attempts24h ?? "-"],
  ]

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeaderBanner
          title="Blocked Numbers"
          subtitle="MTN numbers the checkout providers refused. Re-checked daily; customers and shops are told when a number is allowed."
        >
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={exportReport} disabled={busy === "report"}>
              {busy === "report" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileSpreadsheet className="h-4 w-4 mr-2" />}
              Full report
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setSupplier(data?.suppliers[0] ?? ""); setMark(false); setSupplierOpen(true) }}>
              <Download className="h-4 w-4 mr-2" />
              Supplier list
            </Button>
            <Button variant="secondary" size="sm" asChild>
              <Link href="/admin/settings/mtn">
                <Settings className="h-4 w-4 mr-2" />
                Settings
              </Link>
            </Button>
          </div>
        </PageHeaderBanner>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {tiles.map(([label, value]) => (
            <Card key={label}>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold text-primary">{typeof value === "number" ? value.toLocaleString() : value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-1 self-start">
            <CardHeader>
              <CardTitle className="text-base">Attempts by surface (7 d)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {(stats?.surfaces7d ?? []).length === 0 && <p className="text-muted-foreground">No attempts in the last 7 days.</p>}
              {(stats?.surfaces7d ?? []).map((s) => (
                <div key={s.surface} className="flex justify-between">
                  <span>{s.surface}</span>
                  <span className="font-medium tabular-nums">{s.count.toLocaleString()}</span>
                </div>
              ))}
              {stats?.surfaces7dTruncated && <p className="text-xs text-muted-foreground pt-1">Counted from the most recent 20,000 attempts.</p>}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Find numbers</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <form
                className="flex gap-2 sm:col-span-2 lg:col-span-3"
                onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(search.trim()) }}
              >
                <Input placeholder="Phone or shop name" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={60} />
                <Button type="submit" variant="outline">Search</Button>
              </form>
              <select className={SELECT_CLASS} value={status} onChange={(e) => { setPage(1); setStatus(e.target.value) }} aria-label="Status">
                <option value="">All statuses</option>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className={SELECT_CLASS} value={surface} onChange={(e) => { setPage(1); setSurface(e.target.value) }} aria-label="Surface">
                <option value="">All surfaces</option>
                {BLOCK_SURFACES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <div className="flex items-center gap-2">
                <Input type="date" value={from} onChange={(e) => { setPage(1); setFrom(e.target.value) }} aria-label="From date" />
                <span className="text-muted-foreground text-sm">to</span>
                <Input type="date" value={to} onChange={(e) => { setPage(1); setTo(e.target.value) }} aria-label="To date" />
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>
              Numbers {data ? <span className="text-muted-foreground font-normal text-sm">({data.total.toLocaleString()})</span> : null}
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={selected.size === 0 || selected.size > 500 || busy !== null} onClick={() => recheck({ ids: [...selected] })}>
                Re-check selected ({selected.size})
              </Button>
              <Button variant="outline" size="sm" disabled={selected.size === 0 || selected.size > 100 || busy !== null} onClick={() => checkAll([...selected])}>
                Check all providers ({selected.size})
              </Button>
              <Button variant="outline" size="sm" disabled={selected.size === 0 || busy !== null} onClick={() => { setNote(""); setHandleTarget([...selected]) }}>
                Mark handled
              </Button>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => recheck({ all: true })}>
                {busy === "recheck" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                Re-check all due
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {selected.size > 500 && <p className="text-sm text-destructive mb-2">Select at most 500 numbers.</p>}
            {selected.size > 100 && selected.size <= 500 && <p className="text-sm text-muted-foreground mb-2">Check all providers takes at most 100 numbers.</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-2">
                      <input
                        type="checkbox"
                        aria-label="Select all on this page"
                        checked={allOnPage}
                        onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                      />
                    </th>
                    <th className="py-2 pr-3">Phone</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">First / last blocked</th>
                    <th className="py-2 pr-3">Attempts</th>
                    <th className="py-2 pr-3">Surfaces</th>
                    <th className="py-2 pr-3">Shops</th>
                    <th className="py-2 pr-3">Rejected by</th>
                    <th className="py-2 pr-3">Last re-check</th>
                    <th className="py-2 pr-3">Allowed by</th>
                    <th className="py-2 pr-3">Supplier</th>
                    <th className="py-2 pr-3">Texted</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && rows.length === 0 && (
                    <tr><td colSpan={13} className="py-8 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline" /></td></tr>
                  )}
                  {!loading && rows.length === 0 && (
                    <tr><td colSpan={13} className="py-8 text-center text-muted-foreground">No numbers match.</td></tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b align-top">
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.phone}`}
                          checked={selected.has(r.id)}
                          onChange={(e) => {
                            const next = new Set(selected)
                            if (e.target.checked) next.add(r.id)
                            else next.delete(r.id)
                            setSelected(next)
                          }}
                        />
                      </td>
                      <td className="py-2 pr-3 font-mono">{r.phone}</td>
                      <td className="py-2 pr-3"><Badge variant="outline" className={STATUS_STYLE[r.status]}>{r.status}</Badge></td>
                      <td className="py-2 pr-3 whitespace-nowrap">{when(r.first_blocked_at)}<br /><span className="text-muted-foreground">{when(r.last_blocked_at)}</span></td>
                      <td className="py-2 pr-3 tabular-nums">{r.attempts ?? 0}</td>
                      <td className="py-2 pr-3"><div className="flex flex-wrap gap-1">{r.surfaces.map((s) => <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>)}</div></td>
                      <td className="py-2 pr-3">{r.shopNames.join(", ") || "-"}</td>
                      <td className="py-2 pr-3">{(r.providers_rejected ?? []).join(", ") || "-"}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{ago(r.last_rechecked_at)}</td>
                      <td className="py-2 pr-3">{r.allowed_by ?? "-"}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {r.submitted_to_supplier ? `Submitted to ${r.submitted_to_supplier} (${ago(r.submitted_at)})` : "-"}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">{r.customer_notified_at ? when(r.customer_notified_at) : "-"}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1">
                          {(r.status === "blocked" || r.status === "expired") && (
                            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => recheck({ ids: [r.id] })}>Re-check</Button>
                          )}
                          {(r.status === "blocked" || r.status === "expired") && (
                            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => checkAll([r.id])}>All providers</Button>
                          )}
                          {(r.status === "blocked" || r.status === "expired") && (
                            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { setNote(""); setHandleTarget([r.id]) }}>Handled</Button>
                          )}
                          {(r.status === "handled" || r.status === "expired") && (
                            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => reopen(r.id)}>Re-open</Button>
                          )}
                        </div>
                        {r.status === "handled" && r.notes && <p className="text-xs text-muted-foreground mt-1 max-w-[16rem]">{r.notes}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between pt-4">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Previous</Button>
              <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages || loading} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={handleTarget !== null} onOpenChange={(o) => { if (!o) setHandleTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark {handleTarget?.length ?? 0} number(s) handled</DialogTitle>
            <DialogDescription>Handled numbers stop being re-checked. A note is required (what was done).</DialogDescription>
          </DialogHeader>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Registered with Kuntanii on 16 Nov" />
          <p className="text-xs text-muted-foreground text-right">{note.length}/500</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setHandleTarget(null)}>Cancel</Button>
            <Button onClick={submitHandled} disabled={!note.trim() || busy === "handle"}>
              {busy === "handle" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Mark handled
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={allOpen} onOpenChange={(o) => { if (!o) { setAllOpen(false); setAllResult(null) } }}>
        <DialogContent className="max-w-[calc(100vw-2rem)] lg:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Check all providers</DialogTitle>
            <DialogDescription>
              Every configured provider was asked about the selected numbers. Only a provider in your checkout list can make a number Ready.
            </DialogDescription>
          </DialogHeader>
          {!allResult && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Asking every provider. This can take up to a minute.
            </div>
          )}
          {allResult && (
            <div className="space-y-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2 pr-3">Phone</th>
                      {allResult.providers.map((p) => (
                        <th key={p} className="py-2 pr-3 whitespace-nowrap">
                          {p}
                          {allResult.checkoutProviders.includes(p) && <Badge className="ml-1 bg-primary text-primary-foreground text-[10px]">checkout</Badge>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allResult.rows.map((r) => (
                      <tr key={r.id} className="border-b">
                        <td className="py-2 pr-3 font-mono">{r.phone}</td>
                        {allResult.providers.map((p) => (
                          <td key={p} className="py-2 pr-3">
                            {r.results[p] === "allowed" ? (
                              <Badge variant="outline" className="bg-success/10 text-success border-success/30">Allowed</Badge>
                            ) : r.results[p] === "refused" ? (
                              <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">Refused</Badge>
                            ) : (
                              <span className="text-muted-foreground">Error</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(allResult.failedProviders ?? []).length > 0 && (
                <p className="text-sm text-muted-foreground">{allResult.failedProviders!.join(", ")} did not answer — try again later.</p>
              )}
              {allResult.recheckFailed && (
                <p className="text-sm text-destructive">Some numbers are allowed by a checkout provider but could not be moved to Ready. Use Re-check on them.</p>
              )}
              {allResult.flipFailed && (
                <p className="text-sm text-destructive">Some numbers allowed by a provider could not be marked Ready. Run the check again.</p>
              )}
              {allResult.flipped > 0 && (
                <p className="text-sm font-medium text-success">{allResult.flipped} became Ready</p>
              )}
              {(() => {
                // Only rows the direct flip actually updated; never rows whose flip failed or matched nothing.
                const flippedIds = new Set(allResult.flippedOutsideIds ?? [])
                const outside = allResult.rows.filter((r) => flippedIds.has(r.id))
                if (outside.length === 0) return null
                const names = [...new Set(outside.map((r) => r.allowedOutsideCheckout[0]))].join(", ")
                return (
                  <p className="text-sm">
                    Allowed by {names} — these numbers can now be purchased.
                  </p>
                )
              })()}
              <div className="flex flex-wrap gap-2">
                {allResult.providers
                  .filter((p) => allResult.rows.some((r) => r.results[p] === "allowed"))
                  .map((p) => (
                    <Button key={p} variant="outline" size="sm" onClick={() => copyAllowedBy(p)}>
                      <Copy className="h-4 w-4 mr-2" />
                      Copy numbers allowed by {p}
                    </Button>
                  ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setAllOpen(false); setAllResult(null) }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={supplierOpen} onOpenChange={setSupplierOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supplier list</DialogTitle>
            <DialogDescription>One Phone column of every open blocked number, ready to hand to a supplier.</DialogDescription>
          </DialogHeader>
          <label className="text-sm font-medium" htmlFor="supplier">Supplier</label>
          <select id="supplier" className={SELECT_CLASS} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            {(data?.suppliers ?? []).length === 0 && <option value="">No checkout providers configured</option>}
            {(data?.suppliers ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={unsubmitted} onChange={(e) => setUnsubmitted(e.target.checked)} />
            Only numbers not yet submitted to any supplier
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={mark} onChange={(e) => setMark(e.target.checked)} />
            Mark these numbers as submitted to {supplier || "the supplier"}
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSupplierOpen(false)}>Cancel</Button>
            <Button onClick={exportSupplier} disabled={busy === "supplier" || (mark && !supplier)}>
              {busy === "supplier" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
