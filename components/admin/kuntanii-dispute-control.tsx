"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Loader2, RefreshCw, Flag } from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

interface Dispute { id: string; report_reference: string | null; dispute_status: string | null }

const OPEN_STATES = ["open", "escalated"]

async function call(path: string, init: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("Authentication required")
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
  })
  const json = await res.json().catch(() => ({}))
  return { res, json }
}

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "open") return "default"
  if (s === "escalated") return "destructive"
  if (s === "resolved") return "secondary"
  return "outline"
}

/** "Report not received" control for a completed Kuntanii order. Never touches phone numbers. */
export function KuntaniiDisputeControl({ trackingId, status }: { trackingId: string; status: string }) {
  const [dispute, setDispute] = useState<Dispute | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [note, setNote] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const loadDisputes = useCallback(async () => {
    try {
      const { res, json } = await call(`/api/admin/kuntanii?action=disputes&trackingId=${encodeURIComponent(trackingId)}`)
      if (res.ok) setDispute((json.disputes as Dispute[] | undefined)?.[0] ?? null)
    } catch {
      // badge is best-effort
    }
  }, [trackingId])

  useEffect(() => {
    if (status === "completed") void loadDisputes()
  }, [status, loadDisputes])

  if (status !== "completed") return null

  const isOpen = !!dispute?.dispute_status && OPEN_STATES.includes(dispute.dispute_status)

  const handleRefresh = async () => {
    if (!dispute) return
    setRefreshing(true)
    try {
      const { res, json } = await call("/api/admin/kuntanii", {
        method: "POST",
        body: JSON.stringify({ action: "refresh-dispute", reportId: dispute.id }),
      })
      if (!res.ok) throw new Error(json.error || "Could not refresh the dispute")
      setDispute({ ...dispute, dispute_status: json.disputeStatus ?? dispute.dispute_status })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not refresh the dispute")
    } finally {
      setRefreshing(false)
    }
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const { res, json } = await call("/api/admin/kuntanii", {
        method: "POST",
        body: JSON.stringify({ action: "report-not-received", trackingId, description: note.trim() || undefined }),
      })
      if (res.status === 409) {
        toast.error("A report is already open")
        setDialogOpen(false)
        await loadDisputes()
        return
      }
      if (!res.ok) {
        // 502 "Outcome unknown" and other errors: show the server message verbatim.
        toast.error(json.error || "Failed to file the report", { duration: 15000 })
        setDialogOpen(false)
        setNotice(json.error || "Failed to file the report")
        await loadDisputes()
        return
      }
      if (json.warning) {
        const msg = `${json.warning} Reference: ${json.reportReference}`
        setNotice(msg)
        toast.warning(msg, { duration: 30000 })
      } else {
        toast.success(`Report filed. Reference: ${json.reportReference}`)
      }
      setDialogOpen(false)
      setNote("")
      await loadDisputes()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to file the report")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        {dispute?.dispute_status && (
          <>
            <Badge variant={statusVariant(dispute.dispute_status)} title={dispute.report_reference ?? undefined}>
              Not received: {dispute.dispute_status}
            </Badge>
            <Button size="sm" variant="ghost" onClick={handleRefresh} disabled={refreshing} title="Refresh dispute status">
              {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            </Button>
          </>
        )}
        {!isOpen && (
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            <Flag className="w-3 h-3 mr-1" />
            Report not received
          </Button>
        )}
      </div>
      {notice && <p className="max-w-[260px] whitespace-normal text-xs font-semibold text-destructive">{notice}</p>}

      <AlertDialog open={dialogOpen} onOpenChange={(o) => { if (!submitting) setDialogOpen(o) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Report data not received?</AlertDialogTitle>
            <AlertDialogDescription>
              This files a not-received report with Kuntanii for this completed order. You can add an optional note.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={500}
            placeholder="Optional note (max 500 characters)"
            rows={3}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "File report"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
