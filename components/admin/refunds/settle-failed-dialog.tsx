"use client"

import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { SettleFailedDetail } from "@/lib/refunds/ui-outcome"

interface Props {
  info: { message: string; detail: SettleFailedDetail } | null
  onAcknowledge: () => void
}

/** Cannot be dismissed by outside click or Escape: the admin must explicitly acknowledge. */
export function SettleFailedDialog({ info, onAcknowledge }: Props) {
  const rows: [string, string | null][] = info
    ? [
        ["Refund ID", info.detail.refundId],
        ["Gateway reference", info.detail.ref],
        ["Ledger status", info.detail.ledgerStatus],
        ["Note", info.detail.note],
        ["Error", info.detail.error],
      ]
    : []
  return (
    <Dialog open={!!info}>
      <DialogContent
        className="max-w-lg border-destructive"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" /> The payout may have gone out
          </DialogTitle>
          <DialogDescription>
            The money may already have left, but the refund ledger could not be updated. Do NOT retry or refund again.
            Check the refund ledger and the gateway dashboard manually using the details below.
          </DialogDescription>
        </DialogHeader>
        {info && (
          <div className="space-y-3 text-sm">
            <p className="rounded-md border border-destructive/50 p-3 text-destructive">{info.message}</p>
            <dl className="space-y-1 rounded-md border p-3 font-mono text-xs">
              {rows.map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-36 shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="break-all">{v ?? "(not provided)"}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <DialogFooter>
          <Button variant="destructive" onClick={onAcknowledge}>I have noted these details</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
