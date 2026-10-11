"use client"
import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, FileText, Globe, MessageCircle } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api, type ReviewDetail, type ReviewRow } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { maskIdCard, timeAgo, waLink } from "../_lib/view"
import { ConfirmDialog, CopyButton, EmptyState, ErrorBox, LoadingRows, StatusBadge } from "./ui-bits"

const BASE = "/api/admin/sms-platform/business-reviews"

const DOC_LINK_TTL_MS = 280_000 // signed links expire after 5 minutes

function ReviewCard({ row, forceRetry, onPartial, onRetried, onChanged }: {
  row: ReviewRow; forceRetry: boolean; onPartial: (id: string) => void; onRetried: (id: string) => void; onChanged: () => void
}) {
  const [action, setAction] = useState<null | "approve" | "reject" | "retry">(null)
  const [busy, setBusy] = useState(false)
  const [docs, setDocs] = useState<ReviewDetail | null>(null)
  const wa = waLink(row.whatsapp_number)

  // Drop the signed links before they expire; cleared on close/unmount.
  useEffect(() => {
    if (!docs) return
    const t = setTimeout(() => setDocs(null), DOC_LINK_TTL_MS)
    return () => clearTimeout(t)
  }, [docs])

  async function post(body: { action: "approve" | "reject" | "retry_mode"; reason?: string }, success: string) {
    setBusy(true)
    try {
      const res = (await api(`${BASE}/${row.id}`, { method: "POST", body: JSON.stringify(body) })) as { success: boolean; error?: string; approved?: boolean }
      if (res.success) {
        toast.success(success)
        if (body.action === "retry_mode") onRetried(row.id)
      } else if (body.action === "approve" && res.approved === true) {
        toast.error("Approved — but the account could not be switched to Business mode. Open 'Previously approved' and use 'Switch to Business mode'.")
        onPartial(row.id)
      } else toast.error(res.error ?? "Something went wrong")
    } finally {
      setBusy(false)
      setAction(null)
      onChanged() // reload even on failure: an approval can be recorded while the mode switch failed
    }
  }

  async function viewDocs() {
    setBusy(true)
    try {
      const res = await api<ReviewDetail>(`${BASE}/${row.id}`)
      if (res.success && res.data) setDocs(res.data)
      else toast.error(res.error ?? "Could not open the documents")
    } finally {
      setBusy(false)
    }
  }

  const needsModeRetry = row.status === "approved" && ((!!row.account && row.account.mode !== "business") || forceRetry)

  return (
    <Card className="clay border-0 py-0">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 break-words font-semibold">{row.business_name ?? "Untitled business"}</h3>
          <StatusBadge status={row.status} />
          {row.account && <Badge variant="outline">{row.account.mode === "business" ? "Business mode" : "Platform mode"}</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">{row.status === "submitted" ? `Submitted ${timeAgo(row.submitted_at)}` : `Decided ${timeAgo(row.reviewed_at)}`}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex min-w-0 max-w-full items-center gap-1"><span className="min-w-0 truncate">{row.account?.email ?? "Unknown user"}</span>{row.account && <CopyButton value={row.account.user_id} title="Copy user ID" />}</span>
          <span>{maskIdCard(row.ghana_card_last4)}</span>
          {row.website && (
            <a href={row.website} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 max-w-full items-center gap-1 text-primary hover:underline">
              <Globe className="size-3.5 shrink-0" /><span className="min-w-0 truncate">{row.website.replace(/^https?:\/\//, "")}</span>
            </a>
          )}
        </div>
        {row.description && <p className="clay-inset break-words rounded-xl px-3 py-2 text-sm">{row.description}</p>}
        {row.rejection_reason && <p className="text-sm text-red-600 dark:text-red-300">Rejected: {row.rejection_reason}</p>}

        <div className="flex flex-wrap gap-2">
          {wa && <Button asChild size="sm" variant="outline" className="max-w-full"><a href={wa} target="_blank" rel="noopener noreferrer"><MessageCircle className="size-4" />Chat {row.whatsapp_number}</a></Button>}
          {(row.has_ghana_card_doc || row.has_registration_doc) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void viewDocs()}><FileText className="size-4" />View documents</Button>
          )}
          {row.status === "submitted" && (
            <>
              <Button size="sm" disabled={busy} onClick={() => setAction("approve")}>Approve</Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => setAction("reject")}>Reject</Button>
            </>
          )}
          {needsModeRetry && <Button size="sm" disabled={busy} onClick={() => setAction("retry")}>Switch to Business mode</Button>}
        </div>
      </CardContent>

      <ConfirmDialog open={action === "approve"} onOpenChange={(o) => !o && setAction(null)} busy={busy}
        title={`Approve ${row.business_name ?? "this business"}?`} confirmLabel="Approve"
        description="Switches the account to Business mode (higher limits, up to 200 sender IDs) and re-activates its paused sender IDs."
        onConfirm={() => post({ action: "approve" }, "Approved")} />
      <ConfirmDialog open={action === "retry"} onOpenChange={(o) => !o && setAction(null)} busy={busy}
        title={`Switch ${row.business_name ?? "this account"} to Business mode?`} confirmLabel="Switch to Business mode"
        description="Switches this account to Business mode, re-activates its paused sender IDs and sends the customer a 'Business verified' notification."
        onConfirm={() => post({ action: "retry_mode" }, "Account switched to Business mode")} />
      <ConfirmDialog open={action === "reject"} onOpenChange={(o) => !o && setAction(null)} busy={busy} destructive minReason={5}
        title="Reject this application?" confirmLabel="Reject" reasonLabel="Reason (shown to the customer)"
        onConfirm={(reason) => post({ action: "reject", reason }, "Rejected")} />

      <Dialog open={!!docs} onOpenChange={(o) => !o && setDocs(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Documents — {row.business_name}</DialogTitle>
            <DialogDescription>Private links that expire in 5 minutes. Viewing is recorded in the audit log.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {docs?.ghana_card_doc_url
              ? <Button asChild variant="outline"><a href={docs.ghana_card_doc_url} target="_blank" rel="noopener noreferrer">Open Ghana Card</a></Button>
              : <p className="text-sm text-muted-foreground">No Ghana Card document.</p>}
            {docs?.registration_doc_url
              ? <Button asChild variant="outline"><a href={docs.registration_doc_url} target="_blank" rel="noopener noreferrer">Open registration document</a></Button>
              : <p className="text-sm text-muted-foreground">No registration document.</p>}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function ReviewList({ status, emptyTitle, retryIds, onCount, onPartial, onRetried, onChanged }: {
  status: "submitted" | "approved" | "rejected"; emptyTitle: string; retryIds: Set<string>
  onCount?: (n: number) => void; onPartial: (id: string) => void; onRetried: (id: string) => void; onChanged: () => void
}) {
  const { data, error, loading, reload } = useLoad<ReviewRow[]>(() => api<ReviewRow[]>(`${BASE}?status=${status}`), [status])
  useEffect(() => { if (data) onCount?.(data.length) }, [data, onCount])
  if (loading && !data) return <LoadingRows />
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />
  if (!data || data.length === 0) return <EmptyState title={emptyTitle} />
  return (
    <div className="space-y-3">
      {data.map((r) => (
        <ReviewCard key={r.id} row={r} forceRetry={retryIds.has(r.id)} onPartial={onPartial} onRetried={onRetried} onChanged={() => { void reload(); onChanged() }} />
      ))}
    </div>
  )
}

function Fold({ title, count, open, onOpenChange, children }: { title: string; count: number | null; open: boolean; onOpenChange: (o: boolean) => void; children: React.ReactNode }) {
  return (
    <div>
      <button type="button" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => onOpenChange(!open)}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}{title}{count !== null ? ` (${count})` : ""}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  )
}

export default function BusinessReviewsTab({ onChanged }: { onChanged: () => void }) {
  const [retryIds, setRetryIds] = useState<Set<string>>(() => new Set())
  const [approvedOpen, setApprovedOpen] = useState(false)
  const [rejectedOpen, setRejectedOpen] = useState(false)
  const [approvedKey, setApprovedKey] = useState(0)
  const [approvedCount, setApprovedCount] = useState<number | null>(null)
  const [rejectedCount, setRejectedCount] = useState<number | null>(null)

  const onPartial = useCallback((id: string) => {
    setRetryIds((prev) => new Set(prev).add(id))
    setApprovedOpen(true)
    setApprovedKey((k) => k + 1) // remount the list so it reloads even if the fold was already open
  }, [])
  const onRetried = useCallback((id: string) => {
    setRetryIds((prev) => { const n = new Set(prev); n.delete(id); return n })
  }, [])
  const toggleApproved = (o: boolean) => { setApprovedOpen(o); if (!o) setApprovedCount(null) }
  const toggleRejected = (o: boolean) => { setRejectedOpen(o); if (!o) setRejectedCount(null) }

  return (
    <div className="space-y-5">
      <ReviewList status="submitted" emptyTitle="No applications waiting for review" retryIds={retryIds} onPartial={onPartial} onRetried={onRetried} onChanged={onChanged} />
      <Fold title="Previously approved" count={approvedCount} open={approvedOpen} onOpenChange={toggleApproved}>
        <ReviewList key={approvedKey} status="approved" emptyTitle="Nothing approved yet" retryIds={retryIds} onCount={setApprovedCount} onPartial={onPartial} onRetried={onRetried} onChanged={onChanged} />
      </Fold>
      <Fold title="Previously rejected" count={rejectedCount} open={rejectedOpen} onOpenChange={toggleRejected}>
        <ReviewList status="rejected" emptyTitle="Nothing rejected" retryIds={retryIds} onCount={setRejectedCount} onPartial={onPartial} onRetried={onRetried} onChanged={onChanged} />
      </Fold>
    </div>
  )
}
