"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { userDisplayName } from "@/lib/support-admin-client"
import { adminApi } from "./support-api"
import { formatDateTime } from "./order-details-dialog"
import { SupplierBadge } from "./supplier-badge"
import type { LegacyComplaint } from "./legacy-tab"
import { supabase } from "@/lib/supabase"

export const LEGACY_STATUS_STYLES: Record<string, string> = {
  pending: "bg-warning/15 text-warning border-border",
  in_review: "bg-primary/10 text-primary border-primary/20",
  resolved: "bg-success/15 text-success border-border",
  rejected: "bg-destructive/10 text-destructive border-border",
}

export function LegacyStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={LEGACY_STATUS_STYLES[status] ?? ""}>
      {status.replace("_", " ")}
    </Badge>
  )
}

interface EvidenceUrls {
  balance_image_url?: string | null
  momo_receipt_url?: string | null
}

export function LegacyDetailDialog({
  complaint,
  onClose,
  onChanged,
}: {
  complaint: LegacyComplaint | null
  onClose: () => void
  onChanged: () => void
}) {
  const [notes, setNotes] = useState("")
  const [busy, setBusy] = useState<"resolved" | "rejected" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<EvidenceUrls>({})
  const guard = useRef(false)
  const id = complaint?.id ?? null

  useEffect(() => {
    setNotes("")
    setError(null)
    setEvidence({})
    guard.current = false
    if (!complaint || !complaint.has_evidence) return
    let alive = true
    void (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (!session?.access_token) return
        // This older route answers a bare object, not the { success, data } envelope.
        const res = await fetch("/api/admin/complaints/evidence-urls", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            balanceImagePath: complaint.evidence_paths?.balance_image_path ?? null,
            momoReceiptPath: complaint.evidence_paths?.momo_receipt_path ?? null,
          }),
        })
        if (res.ok && alive) setEvidence(await res.json())
      } catch {
        /* photos simply stay hidden */
      }
    })()
    return () => {
      alive = false
    }
    // Keyed on the complaint id: a list refresh must not refetch signed URLs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function resolve(status: "resolved" | "rejected") {
    if (!complaint || guard.current) return
    guard.current = true
    setBusy(status)
    setError(null)
    try {
      const r = await adminApi("/api/admin/complaints/resolve", {
        method: "POST",
        body: { id: complaint.id, status, resolution_notes: notes.trim() },
      })
      if (r.ok) {
        onChanged()
        onClose()
      } else if (r.status === 409) {
        setError("This complaint is already resolved")
        onChanged()
      } else {
        setError(r.error ?? "Could not update the complaint")
      }
    } finally {
      guard.current = false
      setBusy(null)
    }
  }

  const c = complaint
  const actionable = c?.status === "pending" || c?.status === "in_review"
  const pkg = c?.order ? [c.order.network, c.order.size].filter(Boolean).join(" ") : ""
  const photos = [
    { label: "Balance screenshot", url: evidence.balance_image_url },
    { label: "MoMo receipt", url: evidence.momo_receipt_url },
  ].filter((p): p is { label: string; url: string } => !!p.url)

  return (
    <Dialog open={!!c} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] w-[95vw] max-w-2xl overflow-y-auto sm:w-full">
        <DialogHeader>
          <DialogTitle>Complaint</DialogTitle>
          <DialogDescription>{c ? userDisplayName(c.user) : ""}</DialogDescription>
        </DialogHeader>
        {c && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <LegacyStatusBadge status={c.status} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Supplier</p>
                <SupplierBadge supplier={c.supplier} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Beneficiary</p>
                <p className="font-medium">{c.order?.beneficiary ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Order placed</p>
                <p className="font-medium">{formatDateTime(c.order?.created_at)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Order reference</p>
                <p className="font-medium">{c.order?.reference ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Package</p>
                <p className="font-medium">{pkg || "—"}</p>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="break-words font-medium">{c.title}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{c.description}</p>
            </div>

            {photos.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {photos.map((p) => (
                  <a key={p.label} href={p.url} target="_blank" rel="noopener noreferrer" className="block">
                    <p className="mb-1 text-xs text-muted-foreground">{p.label}</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt={p.label} className="max-h-56 w-full rounded-lg border border-border object-contain" />
                  </a>
                ))}
              </div>
            )}

            <div>
              <p className="mb-1 text-sm font-medium">Resolution Notes</p>
              {actionable ? (
                <Textarea value={notes} maxLength={2000} rows={3} onChange={(e) => setNotes(e.target.value)} placeholder="What was done about this complaint?" />
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{c.resolution_notes || "No notes."}</p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {actionable && (
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => resolve("rejected")}>
                  {busy === "rejected" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  Reject
                </Button>
                <Button type="button" disabled={busy !== null} onClick={() => resolve("resolved")}>
                  {busy === "resolved" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  Mark Resolved
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
