"use client"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { api, type FlagRow, type FlagsPage, type HeldActionData, type HeldRow, type OverviewData } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { formatCount, formatGmt, heldActionMessage, heldSummary, isValidRejectReason, previewTotals, shouldResetPage, timeAgo, toneClass } from "../_lib/view"
import { ConfirmDialog, CopyButton, EmptyState, ErrorBox, LoadingRows, Pager, StatusBadge } from "./ui-bits"

const DECISION_TEXT: Record<string, string> = {
  allow: "would pass", hold: "would be held", reject: "would be rejected", block: "would be blocked",
  unavailable: "would be refused (switch off)", error: "could not be scored",
}
const DECISION_ORDER = ["allow", "hold", "reject", "block", "unavailable", "error"]

function PolicyPreview({ rows }: { rows: OverviewData["policyPreview"] }) {
  const t = previewTotals(rows)
  const attention = rows.filter((r) => r.code !== "OK")
  return (
    <Card className="clay border-0 py-0">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-base">Policy preview — last 7 days</CardTitle>
        <CardDescription>
          What the new sending rules <em>would</em> have done. Record-only: nothing was blocked, capped or flagged. Use it to tune limits and keyword lists before enforcement ships.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-4">
        {t.total === 0 ? (
          <p className="text-sm text-muted-foreground">No sends recorded yet — this fills in as customers send.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{formatCount(t.total)} sends evaluated</Badge>
              {DECISION_ORDER.filter((d) => t.byDecision[d]).map((d) => (
                <Badge key={d} variant="outline" className={toneClass(d === "allow" ? "success" : d === "hold" || d === "unavailable" ? "warning" : "danger")}>
                  {formatCount(t.byDecision[d])} {DECISION_TEXT[d] ?? d}
                </Badge>
              ))}
            </div>
            {attention.length > 0 && (
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                {attention.map((r) => <li key={`${r.decision}-${r.code}`}><span className="break-all font-mono">{r.code}</span> — {formatCount(r.count)}</li>)}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

type Severity = "" | "fraud" | "info"

function FlagCard({ row, onChanged, stale }: { row: FlagRow; onChanged: () => void; stale?: boolean }) {
  const [action, setAction] = useState<null | "dismiss" | "suspend">(null)
  const [busy, setBusy] = useState(false)
  async function run(kind: "dismiss" | "suspend") {
    if (busy) return
    setBusy(true)
    try {
      const res = await api(`/api/admin/sms-platform/flags/${encodeURIComponent(row.id)}`, { method: "POST", body: JSON.stringify({ source: row.source, action: kind }) })
      if (res.success) toast.success(kind === "dismiss" ? "Flag dismissed" : "Account suspended")
      else toast.error(res.error ?? "Something went wrong")
    } finally {
      setBusy(false)
      setAction(null)
      onChanged()
    }
  }
  return (
    <Card className="clay border-0 py-0">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={row.severity} label={row.severity === "fraud" ? "Fraud" : "Info"} />
          <span className="min-w-0 break-words text-sm font-medium">{row.reason}</span>
          {row.matched && <Badge variant="secondary" className="max-w-full break-all font-mono">{row.matched}</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">{timeAgo(row.created_at)}</span>
        </div>
        {row.message && <p className="clay-inset line-clamp-4 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm">{row.message}</p>}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">User <span className="font-mono">{row.user_id.slice(0, 8)}…</span><CopyButton value={row.user_id} title="Copy user ID" /></span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy || stale} onClick={() => setAction("dismiss")}>Dismiss</Button>
            <Button size="sm" variant="destructive" disabled={busy || stale} onClick={() => setAction("suspend")}>Suspend account</Button>
          </div>
        </div>
      </CardContent>
      <ConfirmDialog open={action === "dismiss"} onOpenChange={(o) => !o && setAction(null)} busy={busy}
        title="Dismiss this flag?" confirmLabel="Dismiss" description="Marks it reviewed; the account is not changed."
        onConfirm={() => run("dismiss")} />
      <ConfirmDialog open={action === "suspend"} onOpenChange={(o) => !o && setAction(null)} busy={busy} destructive
        title="Suspend this account?" confirmLabel="Suspend"
        description="The customer can't send SMS until you unsuspend them in the Accounts tab. The flag is marked as actioned."
        onConfirm={() => run("suspend")} />
    </Card>
  )
}

function HeldCard({ row, onChanged, stale }: { row: HeldRow; onChanged: () => void; stale?: boolean }) {
  const futureSchedule = row.scheduled_for && Date.parse(row.scheduled_for) > Date.now() ? row.scheduled_for : null
  const [action, setAction] = useState<null | "release" | "reject">(null)
  const [busy, setBusy] = useState(false)
  async function run(kind: "release" | "reject", reason?: string) {
    if (busy) return
    if (kind === "reject" && !isValidRejectReason(reason ?? "")) { toast.error("Give a reason (at least 3 characters)"); return }
    setBusy(true)
    try {
      const res = await api<HeldActionData>(`/api/admin/sms-platform/flags/held/${row.log_id}`, {
        method: "POST", body: JSON.stringify(kind === "reject" ? { action: kind, reason } : { action: kind }),
      })
      if (res.success && res.data) toast.success(heldActionMessage(kind, res.data))
      else toast.error(res.error ?? "Something went wrong")
    } finally {
      setBusy(false)
      setAction(null)
      onChanged()
    }
  }
  return (
    <Card className="clay border-0 py-0">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status="held" label="Held for review" />
          <span className="min-w-0 break-words text-sm font-medium">{row.reason}</span>
          {row.code && <Badge variant="secondary" className="max-w-full break-all font-mono">{row.code}</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">{timeAgo(row.created_at)}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Campaign #{row.log_id} · {heldSummary(row)}{futureSchedule ? ` · scheduled for ${formatGmt(futureSchedule)}` : ""}{row.sender_id ? <> · from <span className="font-mono">{row.sender_id}</span></> : null}
        </p>
        <p className="clay-inset line-clamp-4 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm">{row.message}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {row.email && <span className="min-w-0 break-all">{row.email}</span>}
          {row.user_id && (
            <span className="inline-flex items-center gap-1">User <span className="font-mono">{row.user_id.slice(0, 8)}…</span><CopyButton value={row.user_id} title="Copy user ID" /></span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || stale} onClick={() => setAction("release")}>Release</Button>
            <Button size="sm" variant="destructive" disabled={busy || stale} onClick={() => setAction("reject")}>Reject</Button>
          </div>
        </div>
      </CardContent>
      <ConfirmDialog open={action === "release"} onOpenChange={(o) => !o && setAction(null)} busy={busy}
        title="Release this campaign?" confirmLabel="Release and send"
        description={futureSchedule
          ? <>Approves campaign #{row.log_id} ({heldSummary(row)}). It stays scheduled and is sent at {formatGmt(futureSchedule)}; the customer can still cancel it. Credits were already taken. The customer is notified.</>
          : <>Sends campaign #{row.log_id} to {heldSummary(row)} now. Credits were already taken when it was held. The customer is notified.</>}
        onConfirm={() => run("release")} />
      <ConfirmDialog open={action === "reject"} onOpenChange={(o) => !o && setAction(null)} busy={busy} destructive
        title="Reject this campaign?" confirmLabel="Reject and refund"
        reasonLabel="Reason (shown to the customer)" minReason={3}
        description={<>Campaign #{row.log_id} will not be sent. Every unsent message is refunded to the customer&apos;s SMS balance and they are notified.</>}
        onConfirm={(reason) => run("reject", reason)} />
    </Card>
  )
}

export default function FlaggedTab({ overview, onChanged }: { overview: OverviewData; onChanged: () => void }) {
  const [severity, setSeverity] = useState<Severity>("")
  const [page, setPage] = useState(1)
  const { data, error, loading, reload } = useLoad<FlagsPage>(
    () => api<FlagsPage>(`/api/admin/sms-platform/flags?severity=${severity}&status=open&page=${page}`), [severity, page])
  const held = data?.held ?? []
  const heldTotal = data?.heldTotal ?? held.length

  // Resolving the last row on a later page leaves it empty: step back to page 1.
  useEffect(() => {
    if (data && shouldResetPage(page, data.rows.length)) setPage(1)
  }, [data, page])

  const fraud = overview.stats.fraudFlags
  const all = overview.tabCounts.flagged
  const chips: { id: Severity; label: string; n: number }[] = [
    { id: "", label: "All", n: all }, { id: "fraud", label: "Fraud", n: fraud }, { id: "info", label: "Info", n: Math.max(0, all - fraud) },
  ]
  return (
    <div className="min-w-0 space-y-4">
      <PolicyPreview rows={overview.policyPreview} />
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <Button key={c.label} size="sm" variant={severity === c.id ? "default" : "outline"} onClick={() => { setSeverity(c.id); setPage(1) }}>
            {c.label} <span className="opacity-70">{formatCount(c.n)}</span>
          </Button>
        ))}
      </div>
      {loading && !data ? <LoadingRows /> : error && !data ? <ErrorBox message={error} onRetry={reload} />
        : !data || (data.rows.length === 0 && held.length === 0) ? <EmptyState title="Nothing flagged — all clear" />
        : (<>
          {error && <ErrorBox message={error} onRetry={reload} />}
          {held.length > 0 && (
            <section className="space-y-3" aria-label="Campaigns held for review">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-semibold">Held for review</h3>
                <span className="text-xs text-muted-foreground">
                  {formatCount(heldTotal)} waiting{heldTotal > held.length ? ` · oldest ${formatCount(held.length)} shown` : ""} · credits already taken; release sends, reject refunds
                </span>
              </div>
              <div className={`space-y-3 transition-opacity ${loading ? "pointer-events-none opacity-60" : ""}`} aria-busy={loading}>
                {held.map((r) => <HeldCard key={r.id} row={r} stale={loading} onChanged={() => { void reload(); onChanged() }} />)}
              </div>
            </section>
          )}
          {data.rows.length > 0 && (<>
            {held.length > 0 && <h3 className="text-sm font-semibold">Flags</h3>}
            <div className={`space-y-3 transition-opacity ${loading ? "pointer-events-none opacity-60" : ""}`} aria-busy={loading}>{data.rows.map((r) => <FlagCard key={`${r.source}-${r.id}`} row={r} stale={loading} onChanged={() => { void reload(); onChanged() }} />)}</div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>)}
        </>)}
    </div>
  )
}
