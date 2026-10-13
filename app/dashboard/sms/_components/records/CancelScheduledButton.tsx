"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Loader2, XCircle } from "lucide-react"
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { smsFetch } from "../../_lib/api"
import { SCHEDULED_CANCEL_CONFIRM } from "../../_lib/view"

/** Cancel a scheduled send (credits for unsent messages are refunded server-side). Calls onDone after the toast. */
export function CancelScheduledButton({ id, onDone }: { id: number | string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function cancel() {
    setBusy(true)
    const r = await smsFetch<{ cancelled?: boolean; already?: boolean; refunded?: number }>(
      `/api/sms/logs/${encodeURIComponent(String(id))}/cancel`, { method: "POST" },
    )
    setBusy(false)
    setOpen(false)
    if (r.ok) toast.success(r.data?.already ? "This send was already cancelled." : "Scheduled send cancelled — credits refunded.")
    else toast.error(r.status === 409 ? "This send can no longer be cancelled." : (r.error || "Could not cancel the scheduled send."))
    // Reload either way: a 404/409 means the row is no longer scheduled.
    onDone()
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o) }}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" aria-label={`Cancel scheduled send #${id}`}>
          <XCircle className="h-4 w-4" /> Cancel
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel scheduled send?</AlertDialogTitle>
          <AlertDialogDescription>{SCHEDULED_CANCEL_CONFIRM}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          {/* Plain Button, not AlertDialogAction: the dialog must stay open while the request runs. */}
          <Button onClick={() => { void cancel() }} disabled={busy} aria-label="Confirm cancel scheduled send">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Cancel send
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
