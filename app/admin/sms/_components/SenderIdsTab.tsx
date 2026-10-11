"use client"
import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { api, type SenderRow } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { timeAgo } from "../_lib/view"
import { ConfirmDialog, CopyButton, EmptyState, ErrorBox, LoadingRows, StatusBadge } from "./ui-bits"

const ACT = "/api/admin/sms-platform/sender-ids"

function SenderLine({ row, approvalsReady, onChanged }: { row: SenderRow; approvalsReady: boolean; onChanged: () => void }) {
  const [action, setAction] = useState<null | "approve" | "reject" | "revoke">(null)
  const [busy, setBusy] = useState(false)

  async function run(act: "approve" | "reject" | "revoke", reason?: string) {
    setBusy(true)
    const res = await api(`${ACT}/${row.id}`, { method: "POST", body: JSON.stringify({ action: act, reason }) })
    setBusy(false)
    if (res.success) toast.success(act === "approve" ? "Sender ID approved" : act === "reject" ? "Request rejected" : "Sender ID revoked")
    else toast.error(res.error ?? "Something went wrong")
    setAction(null)
    onChanged()
  }

  const tenant = !!row.sms_account_id
  return (
    <Card className="clay border-0 py-0">
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 break-all font-mono text-base font-semibold">{row.sender_id}</span>
          <CopyButton value={row.sender_id} title="Copy sender ID" />
        </div>
        <StatusBadge status={row.local_status} />
        {row.kyc_free && <Badge variant="secondary">Free ID</Badge>}
        {row.is_pool && <Badge variant="secondary">Pool</Badge>}
        <div className="min-w-0 text-sm text-muted-foreground">
          {tenant ? (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1"><span className="min-w-0 truncate">{row.account?.email ?? "Unknown user"}</span>{row.account && <CopyButton value={row.account.user_id} title="Copy user ID" />}
              {row.account && <span>· {row.account.mode === "business" ? "Business" : "Platform"}</span>}</span>
          ) : <span>Platform sender (managed in SMS Centre)</span>}
        </div>
        <span className="text-xs text-muted-foreground">
          {row.local_status === "pending" ? `Requested ${timeAgo(row.submitted_at ?? row.created_at)}`
            : row.local_status === "active" ? `Approved ${timeAgo(row.approved_at)}`
            : row.revoked_at ? `Revoked ${timeAgo(row.revoked_at)}` : ""}
        </span>
        {row.rejection_reason && <span className="min-w-0 break-words text-xs text-red-600 dark:text-red-300">{row.rejection_reason}</span>}

        {tenant && (
          <div className="ml-auto flex flex-wrap gap-2">
            {row.local_status === "pending" && (
              <>
                <Button size="sm" disabled={busy || !approvalsReady} onClick={() => setAction("approve")}>Approve</Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => setAction("reject")}>Reject</Button>
              </>
            )}
            {(row.local_status === "active" || row.local_status === "paused") && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setAction("revoke")}>Revoke</Button>
            )}
          </div>
        )}
      </CardContent>

      <ConfirmDialog open={action === "approve"} onOpenChange={(o) => !o && setAction(null)} busy={busy}
        title={`Approve ${row.sender_id}?`} confirmLabel="Approve"
        description="The name becomes active immediately for this account. No two accounts can hold the same active name."
        onConfirm={() => run("approve")} />
      <ConfirmDialog open={action === "reject"} onOpenChange={(o) => !o && setAction(null)} busy={busy} destructive minReason={3}
        title={`Reject ${row.sender_id}?`} confirmLabel="Reject" reasonLabel="Reason (shown to the customer)"
        onConfirm={(reason) => run("reject", reason)} />
      <ConfirmDialog open={action === "revoke"} onOpenChange={(o) => !o && setAction(null)} busy={busy} destructive minReason={3}
        title={`Revoke ${row.sender_id}?`} confirmLabel="Revoke" reasonLabel="Reason (kept in the audit log)"
        description="The customer can no longer send with this name. If it was their default, they fall back to the platform sender."
        onConfirm={(reason) => run("revoke", reason)} />
    </Card>
  )
}

function Group({ title, rows, approvalsReady, onChanged, empty }: { title: string; rows: SenderRow[]; approvalsReady: boolean; onChanged: () => void; empty?: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title} ({rows.length})</h3>
      {rows.length === 0 ? (empty ? <EmptyState title={empty} /> : null) : rows.map((r) => <SenderLine key={r.id} row={r} approvalsReady={approvalsReady} onChanged={onChanged} />)}
    </section>
  )
}

export default function SenderIdsTab({ provider, onChanged }: { provider: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad<SenderRow[]>(() => api<SenderRow[]>(`${ACT}?status=all&scope=all`), [])
  const [showOld, setShowOld] = useState(false)
  const changed = () => { void reload(); onChanged() }
  const g = useMemo(() => {
    const rows = data ?? []
    return {
      pending: rows.filter((r) => r.local_status === "pending" && r.sms_account_id),
      active: rows.filter((r) => r.local_status === "active" && r.sms_account_id),
      paused: rows.filter((r) => r.local_status === "paused"),
      old: rows.filter((r) => (r.local_status === "rejected" || r.local_status === "revoked") && r.sms_account_id),
      platform: rows.filter((r) => !r.sms_account_id),
    }
  }, [data])
  const approvalsReady = provider === "hubtel"

  if (loading && !data) return <LoadingRows />
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />
  return (
    <div className="space-y-6">
      {!approvalsReady && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          Approving new sender IDs is available once Hubtel is the active SMS provider — Moolre and mNotify wouldn&apos;t recognise a newly approved name, so campaigns using it would fail. Requests stay safely in the queue until then.
        </div>
      )}
      <Group title="Under review" rows={g.pending} approvalsReady={approvalsReady} onChanged={changed} empty="No sender IDs waiting for review" />
      <Group title="Approved" rows={g.active} approvalsReady={approvalsReady} onChanged={changed} />
      <Group title="Paused until verified" rows={g.paused} approvalsReady={approvalsReady} onChanged={changed} />
      {g.platform.length > 0 && <Group title="Platform senders" rows={g.platform} approvalsReady={approvalsReady} onChanged={changed} />}
      {g.old.length > 0 && (
        <div>
          <button type="button" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => setShowOld((o) => !o)}>
            {showOld ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}Rejected / revoked ({g.old.length})
          </button>
          {showOld && <div className="mt-3"><Group title="Rejected / revoked" rows={g.old} approvalsReady={approvalsReady} onChanged={changed} /></div>}
        </div>
      )}
    </div>
  )
}
