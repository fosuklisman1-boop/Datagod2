"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ArrowRight, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { adminUserService } from "@/lib/admin-service"
import { adminJson, AdminApiError, userApiPath } from "@/lib/admin-users/drawer-client"
import { balanceAfter, parseAmountInput, reasonError, REASON_MAX, REASON_MIN } from "@/lib/admin-users/drawer-params"
import type { WalletTarget } from "./types"

interface BalanceDialogProps {
  user: WalletTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

/**
 * Credit or debit a user's wallet. A reason is required, and a confirmation step shows the balance before
 * and after; the server refuses if the balance has changed since (then the dialog shows the new one).
 */
export function BalanceDialog({ user, open, onOpenChange, onChanged }: BalanceDialogProps) {
  const [type, setType] = useState<"credit" | "debit">("credit")
  const [amountInput, setAmountInput] = useState("")
  const [reason, setReason] = useState("")
  const [step, setStep] = useState<"form" | "confirm">("form")
  const [balance, setBalance] = useState<number | null>(null)
  const [loadingBalance, setLoadingBalance] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [touched, setTouched] = useState(false)

  const loadBalance = async (userId: string, signal?: AbortSignal) => {
    setLoadingBalance(true)
    try {
      const r = await adminJson<{ wallet: { balance: number } | null }>(
        userApiPath(userId, "transactions", { page: 1, pageSize: 1 }), { signal },
      )
      if (!signal?.aborted) setBalance(r.wallet ? r.wallet.balance : null)
    } catch (e: any) {
      if (signal?.aborted || e?.name === "AbortError") return
      toast.error(e?.message || "Could not load the current balance")
    } finally {
      if (!signal?.aborted) setLoadingBalance(false)
    }
  }

  // Each opening starts clean and reads the live balance (the list's figure may be stale).
  useEffect(() => {
    if (!open || !user) return
    setType("credit")
    setAmountInput("")
    setReason("")
    setStep("form")
    setTouched(false)
    setBalance(user.walletBalance)
    const ctrl = new AbortController()
    loadBalance(user.id, ctrl.signal)
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.id])

  const parsedAmount = parseAmountInput(amountInput)
  const reasonErr = reasonError(reason)
  const after = parsedAmount.ok && balance !== null ? balanceAfter(balance, type, parsedAmount.amount) : null
  const overdraft = after !== null && after < 0
  const formError = !parsedAmount.ok ? parsedAmount.error : reasonErr ?? (overdraft ? "Debit would take the balance below 0" : null)

  const submit = async () => {
    if (!user || !parsedAmount.ok || balance === null) return
    setSubmitting(true)
    try {
      const r = await adminUserService.updateUserBalance(user.id, parsedAmount.amount, type, reason.trim(), balance)
      toast.success(`Wallet ${type === "credit" ? "credited" : "debited"}: GHS ${r.balanceBefore.toFixed(2)} → GHS ${r.balance.toFixed(2)}`)
      onChanged()
      onOpenChange(false)
    } catch (e: any) {
      toast.error(e?.message || "Failed to update balance")
      if (e instanceof AdminApiError && e.status === 409) {
        // Balance moved (or a debit no longer fits): show the live balance and let the admin review again.
        await loadBalance(user.id)
        setStep("form")
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{step === "form" ? "Adjust wallet" : "Confirm wallet adjustment"}</DialogTitle>
          <DialogDescription className="break-all">{user?.email}</DialogDescription>
        </DialogHeader>
        {user && step === "form" && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              setTouched(true)
              if (!formError && balance !== null) setStep("confirm")
            }}
          >
            <div>
              <Label className="text-xs text-muted-foreground">Current wallet balance</Label>
              <p className="font-semibold mt-1 text-success flex items-center gap-2">
                {balance === null ? "No wallet" : `GHS ${balance.toFixed(2)}`}
                {loadingBalance && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
              </p>
            </div>
            <div>
              <Label htmlFor="balance-action" className="text-xs">Action</Label>
              <select
                id="balance-action"
                value={type}
                onChange={(e) => setType(e.target.value as "credit" | "debit")}
                className="w-full mt-1 px-3 py-2 border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="credit">Credit (add)</option>
                <option value="debit">Debit (subtract)</option>
              </select>
            </div>
            <div>
              <Label htmlFor="balance-amount" className="text-xs">Amount (GHS)</Label>
              <Input
                id="balance-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="mt-1"
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="balance-reason" className="text-xs">Reason (required, {REASON_MIN}–{REASON_MAX} characters)</Label>
              <Textarea
                id="balance-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={REASON_MAX}
                rows={3}
                placeholder="e.g. Refund for failed order DG-123 that was not auto-refunded"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">Saved in the wallet ledger and the admin audit log.</p>
            </div>
            {touched && formError && <p className="text-sm text-destructive">{formError}</p>}
            <Button type="submit" className="w-full" disabled={balance === null || loadingBalance}>
              Review
            </Button>
          </form>
        )}
        {user && step === "confirm" && parsedAmount.ok && balance !== null && after !== null && (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-sm">
                {type === "credit" ? "Credit" : "Debit"} <strong>GHS {parsedAmount.amount.toFixed(2)}</strong>
              </p>
              <div className="flex items-center justify-between text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Before</p>
                  <p className="font-semibold">GHS {balance.toFixed(2)}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground" />
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">After</p>
                  <p className={`font-semibold ${type === "credit" ? "text-success" : "text-destructive"}`}>GHS {after.toFixed(2)}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Reason</p>
                <p className="text-sm break-words">{reason.trim()}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">The user is notified by SMS, email and push.</p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={submitting} onClick={() => setStep("form")}>Back</Button>
              <Button
                className={`flex-1 ${type === "credit" ? "bg-success hover:bg-success/90" : "bg-destructive hover:bg-destructive/90"}`}
                disabled={submitting}
                onClick={submit}
              >
                {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Confirm {type}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
