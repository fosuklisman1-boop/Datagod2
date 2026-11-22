"use client"

import { AlertTriangle, Loader2, Send } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatGb, rejectReasonLabel, riskyAckReady, type SelectionSummary } from "@/lib/order-queue/confirm-summary"
import type { SupplierOption } from "@/lib/order-queue/supplier-capability"

export const HARD_PIN_COPY = "This supplier is a hard pin — if it refuses an order, it will not try another."
export const HUBNET_COPY = "Hubnet takes about 10 orders a minute."
export const RISKY_WARNING_COPY = "The customer may already have this data — check with the supplier first."
export const RISKY_CHECKBOX_COPY = "I checked these at the supplier"
export const ACK_MISMATCH_COPY = "The held/reversed orders changed — reload and check again."

export type SendConfirmBodyProps = {
  summary: SelectionSummary
  supplier: SupplierOption
  balance?: string
  typedCount: string
  onTypedCountChange: (v: string) => void
  checked: boolean
  onCheckedChange: (v: boolean) => void
  sending: boolean
  error: string | null
  onSend: () => void
  onCancel: () => void
}

const shortId = (id: string) => id.slice(0, 8)

/** The dialog's content, without the Radix portal, so it can be static-rendered in tests. */
export function SendConfirmBody({
  summary,
  supplier,
  balance,
  typedCount,
  onTypedCountChange,
  checked,
  onCheckedChange,
  sending,
  error,
  onSend,
  onCancel,
}: SendConfirmBodyProps) {
  const riskyCount = summary.risky.length
  const toSend = summary.sendable.length + riskyCount
  const canSend = !sending && toSend > 0 && riskyAckReady(riskyCount, typedCount, checked)

  return (
    <div className="space-y-4" data-testid="send-confirm">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Orders</dt>
        <dd className="font-semibold" data-field="count">{summary.count}</dd>
        <dt className="text-muted-foreground">Data</dt>
        <dd className="font-semibold" data-field="gb">{formatGb(summary.totalGb)} GB</dd>
        <dt className="text-muted-foreground">Networks</dt>
        <dd className="font-semibold" data-field="networks">{summary.networks.join(", ") || "—"}</dd>
        <dt className="text-muted-foreground">Supplier</dt>
        <dd className="font-semibold" data-field="supplier">
          {supplier.label}
          {balance && <span className="ml-1 text-xs font-normal text-muted-foreground">({balance})</span>}
        </dd>
      </dl>

      <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm" data-copy="hard-pin">{HARD_PIN_COPY}</p>
      {supplier.value === "hubnet" && (
        <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm" data-copy="hubnet">{HUBNET_COPY}</p>
      )}

      {summary.blocked.length > 0 && (
        <div data-section="blocked" className="text-sm">
          <p className="font-medium">{summary.blocked.length} will not be sent:</p>
          <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
            {summary.blocked.map(({ row, reason }) => (
              <li key={row.id} className="break-words">
                <span className="font-mono">{shortId(row.id)}</span> — {rejectReasonLabel(reason)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {riskyCount > 0 && (
        <div data-section="risky" className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="flex items-start gap-2 font-semibold text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {riskyCount} held/reversed order{riskyCount === 1 ? "" : "s"}. {RISKY_WARNING_COPY}
            </span>
          </p>
          <ul className="max-h-28 space-y-0.5 overflow-y-auto text-xs">
            {summary.risky.map((r) => (
              <li key={r.id} className="break-words">
                <span className="font-mono">{shortId(r.id)}</span> · {r.network} · {r.volumeGb ?? "?"}GB · {r.status}
                {r.lastProvider ? ` · last: ${r.lastProvider}` : ""}
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--primary)]"
              checked={checked}
              onChange={(e) => onCheckedChange(e.target.checked)}
              data-ack="checkbox"
            />
            <span>{RISKY_CHECKBOX_COPY}</span>
          </label>
          <label className="block space-y-1">
            <span>Type the number of held/reversed orders to confirm</span>
            <Input
              inputMode="numeric"
              value={typedCount}
              onChange={(e) => onTypedCountChange(e.target.value)}
              className="w-28"
              data-ack="count"
              aria-label="Number of held/reversed orders"
            />
          </label>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription data-field="error">{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={sending}>
          Cancel
        </Button>
        <Button onClick={onSend} disabled={!canSend} data-action="send">
          {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
          Send {toSend} to {supplier.label}
        </Button>
      </div>
    </div>
  )
}

export type SendConfirmDialogProps = Omit<SendConfirmBodyProps, "supplier"> & {
  supplier: SupplierOption | null
  onOpenChange: (open: boolean) => void
}

export function SendConfirmDialog({ supplier, onOpenChange, ...body }: SendConfirmDialogProps) {
  return (
    <Dialog open={supplier !== null} onOpenChange={(open) => !body.sending && onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send to {supplier?.label ?? "supplier"}</DialogTitle>
          <DialogDescription>The server checks every order again before anything is sent.</DialogDescription>
        </DialogHeader>
        {supplier && <SendConfirmBody supplier={supplier} {...body} />}
      </DialogContent>
    </Dialog>
  )
}
