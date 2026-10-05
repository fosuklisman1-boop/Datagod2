"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface Props {
  open: boolean
  otp: string
  message: string | null
  busy: boolean
  onChange: (v: string) => void
  onSubmit: () => void
  onClose: () => void
}

export function OtpDialog({ open, otp, message, busy, onChange, onSubmit, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Enter payout OTP</DialogTitle>
          <DialogDescription>
            Paystack sent a one-time code to release this refund payout. The shop owner&apos;s cut stays removed until you finish or cancel.
          </DialogDescription>
        </DialogHeader>
        {message && <p className="rounded-md border border-destructive/50 p-2 text-sm text-destructive">{message}</p>}
        <Input inputMode="numeric" autoComplete="one-time-code" placeholder="OTP code" value={otp} disabled={busy} onChange={(e) => onChange(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Later</Button>
          <Button disabled={busy || otp.trim().length < 4} onClick={onSubmit}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Release payout
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
