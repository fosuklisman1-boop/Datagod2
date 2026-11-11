"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { UUID_RE } from "@/lib/momo-claim/admin-validate"
import { actionNeedsReason, adminErrorMessage, formatGhs, type RowAction } from "@/lib/momo-claim/admin-view"
import { adminFetch, ApiError, MOMO_API, type Tx } from "./api"

const TITLES: Record<RowAction, string> = {
  void: "Void this payment?",
  restore: "Restore this payment?",
  unflag: "Unflag this payment?",
  credit: "Approve and credit?",
  assign: "Assign to a user?",
}

const BODY: Record<RowAction, string> = {
  void: "A voided payment can no longer be claimed. You can restore it later.",
  restore: "The payment goes back to pending and can be claimed again.",
  unflag: "The flag is cleared and the payment returns to pending. If it was flagged for a review reason it will just re-flag on the next claim.",
  credit: "The linked user's wallet is credited with the net amount. This cannot be undone here.",
  assign: "The user you choose is credited. This cannot be undone here.",
}

export function ActionDialog({
  target,
  onClose,
  onDone,
}: {
  target: { tx: Tx; action: RowAction } | null
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [reason, setReason] = useState("")
  const [userId, setUserId] = useState("")
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setReason("")
    setUserId("")
    setAmount("")
    setError(null)
    setBusy(false)
  }, [target])

  if (!target) return null
  const { tx, action } = target
  const needsReason = actionNeedsReason(action)
  const needsUser = action === "assign"
  const needsAmount = action === "assign" && tx.status === "unparsed"

  const reasonOk = !needsReason || (reason.trim().length >= 1 && reason.trim().length <= 200)
  const userOk = !needsUser || UUID_RE.test(userId.trim())
  const amountNum = Number(amount)
  const amountOk = !needsAmount || (amount.trim() !== "" && Number.isFinite(amountNum) && amountNum > 0 && amountNum < 1_000_000 && /^\d+(\.\d{1,2})?$/.test(amount.trim()))
  const canSubmit = reasonOk && userOk && amountOk && !busy

  async function submit() {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { action, transactionId: tx.transaction_id }
      if (needsReason) body.reason = reason.trim()
      if (needsUser) body.targetUserId = userId.trim()
      if (needsAmount) body.amount = amountNum
      await adminFetch(MOMO_API, { method: "PATCH", body })
      onDone(`Done: ${action === "credit" ? "approved and credited" : action === "assign" ? "assigned" : action === "restore" ? "restored" : action === "void" ? "voided" : "unflagged"}`)
    } catch (e) {
      setError(adminErrorMessage(e instanceof ApiError ? e.code : undefined))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{TITLES[action]}</DialogTitle>
          <DialogDescription>
            {BODY[action]}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded-md border bg-muted/40 p-3">
            <div className="font-mono text-xs break-all">{tx.transaction_id}</div>
            <div className="mt-1">{formatGhs(tx.amount)} {tx.network ? `on ${tx.network}` : ""}</div>
          </div>
          {needsUser && (
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="mc-user">User ID (UUID)</label>
              <Input id="mc-user" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono text-xs" />
              {userId.trim() !== "" && !userOk && <p className="text-xs text-red-600 dark:text-red-400">Enter a valid user ID.</p>}
            </div>
          )}
          {needsAmount && (
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="mc-amt">Amount to credit (GHS)</label>
              <Input id="mc-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              {amount.trim() !== "" && !amountOk && <p className="text-xs text-red-600 dark:text-red-400">Up to 2 decimals, more than 0.</p>}
            </div>
          )}
          {needsReason && (
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="mc-reason">Reason (required, max 200)</label>
              <Textarea id="mc-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} rows={3} />
            </div>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
