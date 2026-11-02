"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Loader2 } from "lucide-react"
import { adminJson } from "@/lib/admin-users/drawer-client"

/** GET a drawer route; refetches when `path` changes and aborts the previous request. */
export function useAdminGet<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!path) return
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    adminJson<T>(path, { signal: ctrl.signal })
      .then((d) => { if (!ctrl.signal.aborted) setData(d) })
      .catch((e) => {
        if (ctrl.signal.aborted || e?.name === "AbortError") return
        setError(e instanceof Error ? e.message : "Failed to load")
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  }, [path, nonce])

  return { data, error, loading, reload: () => setNonce((n) => n + 1) }
}

export const ghs = (n: number | string | null | undefined) => `GHS ${Number(n ?? 0).toFixed(2)}`
export const dateTime = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "—")
export const dateOnly = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString() : "—")

const STATUS_CLASS: Record<string, string> = {
  completed: "bg-success", delivered: "bg-success", success: "bg-success", approved: "bg-success", paid: "bg-success",
  pending: "bg-warning", processing: "bg-warning", pending_payment: "bg-warning",
  failed: "bg-destructive", rejected: "bg-destructive", cancelled: "bg-destructive",
  refunded: "bg-primary",
}
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = (status ?? "unknown").toLowerCase()
  return <Badge className={`${STATUS_CLASS[s] ?? "bg-muted-foreground"} capitalize`}>{s.replace(/_/g, " ")}</Badge>
}

export function LoadState({ loading, error, onRetry, empty, children }: {
  loading: boolean; error: string | null; onRetry: () => void; empty?: string | false; children: ReactNode
}) {
  if (error) {
    return (
      <div className="py-8 text-center text-sm text-destructive space-y-2">
        <p>{error}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    )
  }
  if (loading && empty !== false) {
    return (
      <div className="py-8 flex items-center justify-center text-muted-foreground text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    )
  }
  if (empty) return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>
  return <>{children}</>
}

/** Previous/Next paging. When `hasMore` is given it decides "Next" (for totals that are capped lower bounds). */
export function Pager({ page, pageSize, total, loading, onPage, hasMore, totalCapped, shown }: {
  page: number; pageSize: number; total: number; loading?: boolean; onPage: (p: number) => void
  hasMore?: boolean; totalCapped?: boolean; shown?: number
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const next = hasMore ?? page < pages
  if (!next && page === 1) return null
  const first = (page - 1) * pageSize + 1
  const last = shown !== undefined ? first + shown - 1 : Math.min(page * pageSize, total)
  return (
    <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground">
      <span>
        {total === 0 && !shown ? 0 : first}–{last} of {total.toLocaleString()}{totalCapped ? "+" : ""}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" variant="outline" disabled={loading || !next} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  )
}

/** Confirmation step for an account action. onConfirm may throw; the dialog stays open on error. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, destructive, onConfirm }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                onOpenChange(false)
              } catch {
                // The caller reports the error; keep the dialog open so the admin can retry or cancel.
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Shown when a user has more than one wallet row (adjustments are refused until it is fixed). */
export function DuplicateWalletWarning({ rows }: { rows: number }) {
  if (rows <= 1) return null
  return (
    <p role="alert" className="text-xs rounded-md border border-warning bg-warning/10 text-warning p-2">
      This user has {rows} wallet rows. The balance shown is the largest; wallet adjustments are refused until the
      duplicates are merged.
    </p>
  )
}
