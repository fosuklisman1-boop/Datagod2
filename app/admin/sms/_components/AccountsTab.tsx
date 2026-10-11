"use client"
import { useEffect, useState } from "react"
import { Search } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, apiRaw, type AccountRow, type Page } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { accountCredits, formatCount, parseAllocateUnits, parseApiLimit, shouldResetPage } from "../_lib/view"
import { ConfirmDialog, CopyButton, EmptyState, ErrorBox, LoadingRows, Pager, StatusBadge } from "./ui-bits"

type Dialog = null | { kind: "suspend" | "mode" | "limit" | "allocate"; row: AccountRow }

function Actions({ row, open, disabled }: { row: AccountRow; open: (d: Dialog) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {row.status !== "inactive" && (
        <Button size="sm" variant={row.status === "suspended" ? "default" : "outline"} disabled={disabled} onClick={() => open({ kind: "suspend", row })}>
          {row.status === "suspended" ? "Unsuspend" : "Suspend"}
        </Button>
      )}
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => open({ kind: "mode", row })}>Change mode</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => open({ kind: "limit", row })}>API limit</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => open({ kind: "allocate", row })}>Allocate credits</Button>
    </div>
  )
}

function UserCell({ row }: { row: AccountRow }) {
  return (
    <div className="min-w-0">
      <div className="break-all text-sm font-medium">{row.email ?? "No email"}</div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground"><span className="font-mono">{row.user_id.slice(0, 8)}…</span><CopyButton value={row.user_id} title="Copy user ID" /></div>
    </div>
  )
}

const modeLabel = (m: string) => (m === "business" ? "Business" : "Platform")

export default function AccountsTab({ onChanged }: { onChanged: () => void }) {
  const [text, setText] = useState("")
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState("")
  // One idempotency key per opened allocate dialog: retries / double-clicks can never credit twice.
  const [requestId, setRequestId] = useState("")

  useEffect(() => {
    const t = setTimeout(() => { setQ(text.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [text])

  const { data, error, loading, reload } = useLoad<Page<AccountRow>>(
    () => api<Page<AccountRow>>(`/api/admin/sms-platform/accounts?q=${encodeURIComponent(q)}&page=${page}`), [q, page])

  // A filter (or an action) can leave a later page empty: step back to page 1.
  useEffect(() => {
    if (data && shouldResetPage(page, data.rows.length)) setPage(1)
  }, [data, page])

  function open(d: Dialog) {
    setInput(d?.kind === "limit" ? String(d.row.api_rate_limit_override ?? "") : "")
    setRequestId(d?.kind === "allocate" ? crypto.randomUUID() : "")
    setDialog(d)
  }
  function done(message: string) { toast.success(message); setDialog(null); void reload(); onChanged() }

  async function confirm() {
    if (!dialog || busy) return
    const { kind, row } = dialog
    setBusy(true)
    try {
      if (kind === "suspend") {
        const res = await api("/api/admin/shop-sms", { method: "POST", body: JSON.stringify({ action: "set_suspended", accountId: row.id, suspended: row.status !== "suspended" }) })
        if (!res.success) return void toast.error(res.error ?? "Could not update the account")
        done(row.status === "suspended" ? "Account unsuspended" : "Account suspended")
      } else if (kind === "mode") {
        const next = row.mode === "business" ? "platform" : "business"
        const res = await api(`/api/admin/sms-platform/accounts/${row.id}`, { method: "PATCH", body: JSON.stringify({ mode: next }) })
        if (!res.success) return void toast.error(res.error ?? "Could not change the mode")
        done(`Account is now in ${modeLabel(next)} mode`)
      } else if (kind === "limit") {
        const parsed = parseApiLimit(input)
        if (!parsed.ok) return void toast.error(parsed.error)
        const res = await api(`/api/admin/sms-platform/accounts/${row.id}`, { method: "PATCH", body: JSON.stringify({ api_rate_limit_override: parsed.value }) })
        if (!res.success) return void toast.error(res.error ?? "Could not save the limit")
        done(parsed.value === null ? "Using the platform default limit" : `Limit set to ${parsed.value} requests/minute`)
      } else {
        const parsed = parseAllocateUnits(input)
        if (!parsed.ok) return void toast.error(parsed.error)
        const res = await apiRaw<{ success?: boolean; pending?: boolean; unitsCredited?: number; duplicate?: boolean; error?: string }>(
          "/api/admin/sms/allocate", { method: "POST", body: JSON.stringify({ accountId: row.id, units: parsed.value, requestId }) })
        if (res.status === 0) return void toast.error("Connection lost — the allocation may have gone through. Retry from this same dialog (it won't double-credit).")
        if (!res.ok || !res.body?.success) return void toast.error(res.body?.error ?? "Could not allocate credits")
        if (res.body.duplicate) done("Already allocated")
        else done(res.body.pending ? "Queued as pending — SMS supply is short, it will be credited when supply allows" : `Allocated ${formatCount(res.body.unitsCredited ?? parsed.value)} credits`)
      }
    } finally { setBusy(false) }
  }

  const row = dialog?.row
  const suspended = row?.status === "suspended"
  const who = row ? (row.email ?? row.user_id) : ""
  const stale = loading && !!data
  return (
    <div className="min-w-0 space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search user ID, email, sender, mode or status" value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      {loading && !data ? <LoadingRows rows={4} /> : error && !data ? <ErrorBox message={error} onRetry={reload} />
        : !data || data.rows.length === 0 ? <EmptyState title="No accounts found" />
        : (<>
          {error && <ErrorBox message={error} onRetry={reload} />}
          <div className={`min-w-0 space-y-4 transition-opacity ${stale ? "pointer-events-none opacity-60" : ""}`} aria-busy={loading}>
            <div className="clay hidden overflow-hidden md:block">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>User</TableHead><TableHead>Mode</TableHead><TableHead>Status</TableHead><TableHead>Credits</TableHead><TableHead>Default sender</TableHead><TableHead>Actions</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-56"><UserCell row={r} /></TableCell>
                      <TableCell><Badge variant="outline">{modeLabel(r.mode)}</Badge></TableCell>
                      <TableCell><StatusBadge status={r.status} />{r.review_hold && <Badge variant="destructive" className="ml-1">Review hold</Badge>}</TableCell>
                      <TableCell className="text-sm"><div className="font-medium tabular-nums">{formatCount(r.unit_balance)}</div><div className="text-xs text-muted-foreground">{accountCredits(r)}</div></TableCell>
                      <TableCell className="font-mono text-sm">{r.default_sender ?? "—"}{r.api_rate_limit_override != null && <div className="font-sans text-xs text-muted-foreground">API {r.api_rate_limit_override}/min</div>}</TableCell>
                      <TableCell><Actions row={r} open={open} disabled={stale} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-3 md:hidden">
              {data.rows.map((r) => (
                <Card key={r.id} className="clay border-0 py-0"><CardContent className="space-y-2 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <UserCell row={r} />
                    <div className="flex flex-wrap gap-1"><Badge variant="outline">{modeLabel(r.mode)}</Badge><StatusBadge status={r.status} />{r.review_hold && <Badge variant="destructive">Review hold</Badge>}</div>
                  </div>
                  <div className="text-sm"><span className="font-semibold tabular-nums">{formatCount(r.unit_balance)}</span> credits <span className="text-xs text-muted-foreground">· {accountCredits(r)}</span></div>
                  <div className="break-words text-xs text-muted-foreground">Sender <span className="font-mono">{r.default_sender ?? "—"}</span>{r.api_rate_limit_override != null && ` · API ${r.api_rate_limit_override}/min`}</div>
                  <Actions row={r} open={open} disabled={stale} />
                </CardContent></Card>
              ))}
            </div>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>)}

      <ConfirmDialog open={dialog?.kind === "suspend"} onOpenChange={(o) => !o && setDialog(null)} busy={busy} destructive={!suspended}
        title={suspended ? "Unsuspend this account?" : "Suspend this account?"} confirmLabel={suspended ? "Unsuspend" : "Suspend"}
        description={<><b className="break-all">{who}</b>: {suspended ? "the customer can send SMS again." : "the customer can't send SMS or buy credits until you unsuspend them."}</>}
        onConfirm={confirm} />
      <ConfirmDialog open={dialog?.kind === "mode"} onOpenChange={(o) => !o && setDialog(null)} busy={busy}
        title={row?.mode === "business" ? "Switch to Platform mode?" : "Switch to Business mode?"} confirmLabel="Switch mode"
        description={<><b className="break-all">{who}</b>: {row?.mode === "business"
          ? "keeps the account's one free sender ID active and pauses the rest; lowers sending limits and restricts links to the customer's Datagod store."
          : "re-activates paused sender IDs and raises sending limits (up to 200 sender IDs). Normally done by approving the customer's business verification."}</>}
        onConfirm={confirm} />
      <ConfirmDialog open={dialog?.kind === "limit"} onOpenChange={(o) => !o && setDialog(null)} busy={busy}
        title="API rate limit" confirmLabel="Save" description={<>For <b className="break-all">{who}</b>: requests per minute on the public SMS API. Leave empty to use the platform default.</>}
        onConfirm={confirm}>
        <Input aria-label="API rate limit (requests per minute)" inputMode="numeric" placeholder="Platform default" value={input} onChange={(e) => setInput(e.target.value)} />
      </ConfirmDialog>
      <ConfirmDialog open={dialog?.kind === "allocate"} onOpenChange={(o) => !o && setDialog(null)} busy={busy}
        title="Allocate credits" confirmLabel="Allocate" description={<>Adds credits to <b className="break-all">{who}</b>. It is checked against real SMS supply and recorded in the audit log.</>}
        onConfirm={confirm}>
        <Input aria-label="Number of credits to allocate" inputMode="numeric" placeholder="Number of credits (1–1,000,000)" value={input} onChange={(e) => setInput(e.target.value)} />
      </ConfirmDialog>
    </div>
  )
}
