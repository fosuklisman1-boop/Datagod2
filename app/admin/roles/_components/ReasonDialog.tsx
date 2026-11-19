"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { validateReason } from "@/lib/roles/admin/validate"

interface Props {
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  destructive?: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: (reason: string) => void
}

/** Every hub write asks for a reason (3-300 chars). The confirm button is disabled while a request is in flight. */
export function ReasonDialog({ open, title, description, confirmLabel, destructive, busy, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setReason("")
      setError(null)
    }
  }, [open])

  const submit = () => {
    const v = validateReason(reason)
    if (!v.ok) {
      setError(v.error)
      return
    }
    setError(null)
    onConfirm(v.value)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason-input">Reason</Label>
          <Input
            id="reason-input"
            value={reason}
            maxLength={300}
            placeholder="Why are you doing this? (min 3 characters)"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
