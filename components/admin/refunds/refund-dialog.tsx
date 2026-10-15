"use client"

import { useEffect, useState } from "react"
import { Copy, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { postRefundAction } from "./api"
import { parseRefundAmount, treatAsAmbiguous, type RefundOutcome } from "@/lib/refunds/ui-outcome"

export interface PreviewPayload {
  order: { table: string; id: string; paid: number; gatewayFee: number; packageLabel: string; network: string; payment: { payerPhone: string | null } }
  /** warning: refundable only after the admin confirms (admin-overridden Hubtel failure). */
  eligibility: { eligible: true; warning?: string } | { eligible: false; code?: string; reason: string }
  defaultAmount: number
  gateways: { id: string; label: string; ok: boolean; reason?: string }[]
  clawback: { ok: boolean; lines: { shopId: string; credited: number; pending: number; fromProfit: number; fromWallet: number; shortfall: number }[] }
  /** Customer details for a manual refund (who to pay); null when unknown. */
  contact?: {
    name: string | null; email: string | null; phone: string | null
    payerPhone: string | null; recipientPhone: string | null; payTo: string | null
  } | null
}

function ContactRow({ label, value, copyable = true }: { label: string; value: string | null; copyable?: boolean }) {
  if (!value) return null
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 font-medium">
        <span className="break-all">{value}</span>
        {copyable && (
          <button
            type="button"
            aria-label={`Copy ${label}`}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => { navigator.clipboard.writeText(value).then(() => toast.success(`${label} copied`)).catch(() => {}) }}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    </div>
  )
}

interface Props {
  target: { table: string; id: string } | null
  getToken: () => Promise<string>
  onClose: () => void
  onOutcome: (outcome: RefundOutcome) => void
  onReload: () => void
}

export function RefundDialog({ target, getToken, onClose, onOutcome, onReload }: Props) {
  const [preview, setPreview] = useState<PreviewPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [gateway, setGateway] = useState("")
  const [amount, setAmount] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  // Set from the preview, or from a CONFIRM_REQUIRED answer if the order changed after the preview loaded.
  const [overrideWarning, setOverrideWarning] = useState<string | null>(null)
  const [overrideConfirmed, setOverrideConfirmed] = useState(false)
  const [manualReference, setManualReference] = useState("")

  useEffect(() => {
    setPreview(null)
    setError(null)
    setConfirmed(false)
    setManualReference("")
    setOverrideWarning(null)
    setOverrideConfirmed(false)
    if (!target) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const res = await fetch("/api/admin/refunds/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
          body: JSON.stringify({ table: target.table, orderId: target.id }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(res.status === 403 ? "Sign in as an admin" : json.error || "Preview failed")
        if (cancelled) return
        setPreview(json)
        const w = json?.eligibility?.eligible === true && typeof json.eligibility.warning === "string" ? json.eligibility.warning : null
        setOverrideWarning(w)
        setAmount(Number(json.defaultAmount).toFixed(2))
        setGateway(json.gateways.find((g: PreviewPayload["gateways"][number]) => g.ok)?.id ?? "")
      } catch (e) {
        if (cancelled) return
        toast.error(e instanceof Error ? e.message : "Preview failed")
        onClose()
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, getToken])

  const parsed = parseRefundAmount(amount)
  const amountNum = parsed ?? 0
  const amountOk = parsed !== null && (!preview || parsed <= preview.order.paid)
  const gw = preview?.gateways.find((g) => g.id === gateway)
  const cutTotal = preview ? preview.clawback.lines.reduce((s, l) => s + l.credited + l.pending, 0) : 0
  const eligible = preview?.eligibility.eligible === true
  const isManual = gateway === "manual"
  const contact = preview?.contact ?? null
  const cutNote = cutTotal > 0 ? ` - removes GHS ${cutTotal.toFixed(2)} from shop owner(s)` : ""
  const summary =
    preview && gw && amountOk
      ? isManual
        ? `I have already sent GHS ${amountNum.toFixed(2)} to ${contact?.payTo ?? contact?.name ?? "this customer"} myself${cutNote}`
        : `Refund GHS ${amountNum.toFixed(2)} to ${preview.order.payment.payerPhone ?? "the original payer"} via ${gw.label}${cutNote}`
      : ""

  const submit = async () => {
    if (!target || submitting || !confirmed || !amountOk || (overrideWarning && !overrideConfirmed)) return
    setSubmitting(true)
    setError(null)
    try {
      const outcome = await postRefundAction(getToken, "/api/admin/refunds", "execute", {
        table: target.table, orderId: target.id, gateway, amount: amountNum,
        ...(overrideWarning ? { confirmOverride: overrideConfirmed } : {}),
        ...(isManual && manualReference.trim() ? { manualReference: manualReference.trim() } : {}),
      })
      if (outcome.kind === "error" && outcome.confirmWarning) {
        // Nothing was reserved: show the warning and ask for the explicit confirmation.
        setConfirmed(false)
        setOverrideConfirmed(false)
        setOverrideWarning(outcome.confirmWarning)
        return
      }
      if (outcome.kind === "error" || outcome.kind === "auth" || outcome.kind === "settle_failed") {
        setConfirmed(false)
        const t = treatAsAmbiguous(outcome)
        if (outcome.kind === "settle_failed") onOutcome(outcome)
        else if (t === "ambiguous") toast.error("Outcome unknown — check History before retrying")
        if (t === "ambiguous") {
          // Cannot tell whether money moved: never leave the dialog armed.
          onReload()
          onClose()
          return
        }
        setError(outcome.message)
        if (t === "stale") onReload()
        return
      }
      onOutcome(outcome)
      onClose()
    } catch (e) {
      setConfirmed(false)
      toast.error(e instanceof Error ? e.message : "Refund request failed")
    } finally {
      setSubmitting(false)
    }
  }

  const blocked = !preview || !eligible || !preview.clawback.ok || !gateway || !amountOk || !confirmed || submitting
    || (!!overrideWarning && !overrideConfirmed)

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Refund order</DialogTitle>
          <DialogDescription>Moves real money. The shop owner&apos;s cut is removed first, then the customer is paid.</DialogDescription>
        </DialogHeader>

        {loading || !preview ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border p-3">
              <div className="font-medium">{preview.order.packageLabel} {preview.order.network}</div>
              <div className="text-muted-foreground">
                Paid GHS {preview.order.paid.toFixed(2)} · gateway fee GHS {preview.order.gatewayFee.toFixed(2)} · {preview.order.table === "orders" || preview.order.table === "api_orders" ? "paid from the buyer's wallet" : `payer ${preview.order.payment.payerPhone ?? "unknown"}`}
              </div>
            </div>

            {!preview.eligibility.eligible && (
              <div className="rounded-md border border-destructive/50 p-3 text-destructive">{preview.eligibility.reason}</div>
            )}

            <div className="space-y-1.5">
              <div className="font-medium">Gateway</div>
              <div className="space-y-1">
                {preview.gateways.map((g) => (
                  <label key={g.id} className={`flex items-start gap-2 rounded-md border p-2 ${g.ok ? "cursor-pointer" : "opacity-50"}`}>
                    <input
                      type="radio"
                      name="gateway"
                      disabled={!g.ok || submitting}
                      checked={gateway === g.id}
                      onChange={() => { setGateway(g.id); setConfirmed(false) }}
                      className="mt-1"
                    />
                    <span>
                      {g.label}
                      {!g.ok && <span className="block text-xs text-muted-foreground">{g.reason}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="refund-amount" className="font-medium">Amount to refund (GHS)</label>
              <Input
                id="refund-amount"
                type="number"
                step="0.01"
                min="0.01"
                max={preview.order.paid}
                value={amount}
                disabled={submitting}
                onChange={(e) => { setAmount(e.target.value); setConfirmed(false) }}
              />
              <p className="text-xs text-muted-foreground">Default is the price minus the gateway fee. Lower it to keep part. The owner&apos;s full cut is removed either way.</p>
            </div>

            {isManual && (
              <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                <div className="font-medium">Send the refund yourself</div>
                {amountOk && (
                  <div className="rounded-md bg-background p-2 text-center">
                    <div className="text-xs text-muted-foreground">Send</div>
                    <div className="text-lg font-bold text-primary">GHS {amountNum.toFixed(2)}</div>
                    <div className="text-xs text-muted-foreground">
                      {contact?.payTo ? <>to <span className="font-medium text-foreground">{contact.payTo}</span></> : "No payer number recorded: contact the customer for the number to pay"}
                    </div>
                  </div>
                )}
                {contact ? (
                  <div className="space-y-1.5">
                    <ContactRow label="Name" value={contact.name} copyable={false} />
                    <ContactRow label="Pay to" value={contact.payTo} />
                    <ContactRow label="Paid from (MoMo)" value={contact.payerPhone && contact.payerPhone !== contact.payTo ? contact.payerPhone : null} />
                    <ContactRow label="Customer phone" value={contact.phone && contact.phone !== contact.payTo ? contact.phone : null} />
                    <ContactRow label="Email" value={contact.email} />
                    <ContactRow label="Data recipient" value={contact.recipientPhone} />
                    {!contact.name && !contact.payTo && !contact.phone && !contact.email && (
                      <p className="text-xs text-muted-foreground">No customer details are recorded for this order.</p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Customer details could not be loaded. Check the order before sending.</p>
                )}
                <p className="text-xs text-muted-foreground">The data recipient may be someone else: refund the person who paid.</p>
                <div className="space-y-1">
                  <label htmlFor="manual-ref" className="text-xs font-medium">Transaction ID / reference (optional)</label>
                  <Input
                    id="manual-ref"
                    maxLength={100}
                    placeholder="e.g. MoMo transaction ID"
                    value={manualReference}
                    disabled={submitting}
                    onChange={(e) => setManualReference(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="font-medium">Owner cuts to remove</div>
              {preview.clawback.lines.length === 0 ? (
                <p className="text-muted-foreground">No shop earnings are attached to this order.</p>
              ) : (
                preview.clawback.lines.map((l) => (
                  <div key={l.shopId} className="flex items-center justify-between rounded-md border p-2">
                    <span>
                      GHS {(l.credited + l.pending).toFixed(2)}{" "}
                      <span className="text-muted-foreground">(profit {l.fromProfit.toFixed(2)} + wallet {l.fromWallet.toFixed(2)})</span>
                    </span>
                    {l.shortfall > 0 ? <Badge variant="destructive">Short by GHS {l.shortfall.toFixed(2)}</Badge> : <Badge variant="secondary">Covered</Badge>}
                  </div>
                ))
              )}
            </div>

            {overrideWarning && eligible && (
              <label className="flex items-start gap-2 rounded-md border border-destructive/50 p-3">
                <input type="checkbox" className="mt-1" checked={overrideConfirmed} disabled={submitting} onChange={(e) => setOverrideConfirmed(e.target.checked)} />
                <span><span className="font-medium text-destructive">{overrideWarning}</span> I confirmed it was not delivered.</span>
              </label>
            )}

            {summary && eligible && (
              <label className="flex items-start gap-2 rounded-md border border-primary/50 p-3">
                <input type="checkbox" className="mt-1" checked={confirmed} disabled={submitting} onChange={(e) => setConfirmed(e.target.checked)} />
                <span><span className="font-medium">{summary}.</span> {isManual ? "Mark it refunded." : "I confirm this is correct."}</span>
              </label>
            )}

            {error && <div role="alert" className="rounded-md border border-destructive/50 p-3 text-destructive">{error}</div>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={blocked}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
