"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { postRefundAction } from "./api"
import type { RefundOutcome } from "@/lib/refunds/ui-outcome"

export interface PreviewPayload {
  order: { table: string; id: string; paid: number; gatewayFee: number; packageLabel: string; network: string; payment: { payerPhone: string | null } }
  eligibility: { eligible: true } | { eligible: false; code?: string; reason: string }
  defaultAmount: number
  gateways: { id: string; label: string; ok: boolean; reason?: string }[]
  clawback: { ok: boolean; lines: { shopId: string; credited: number; pending: number; fromProfit: number; fromWallet: number; shortfall: number }[] }
}

interface Props {
  target: { table: string; id: string } | null
  getToken: () => Promise<string>
  onClose: () => void
  onOutcome: (outcome: RefundOutcome) => void
}

export function RefundDialog({ target, getToken, onClose, onOutcome }: Props) {
  const [preview, setPreview] = useState<PreviewPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [gateway, setGateway] = useState("")
  const [amount, setAmount] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    setPreview(null)
    setError(null)
    setConfirmed(false)
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

  const amountNum = Number(amount)
  const amountOk = Number.isFinite(amountNum) && amountNum > 0 && (!preview || amountNum <= preview.order.paid)
  const gw = preview?.gateways.find((g) => g.id === gateway)
  const cutTotal = preview ? preview.clawback.lines.reduce((s, l) => s + l.credited + l.pending, 0) : 0
  const eligible = preview?.eligibility.eligible === true
  const summary =
    preview && gw && amountOk
      ? `Refund GHS ${amountNum.toFixed(2)} to ${preview.order.payment.payerPhone ?? "the original payer"} via ${gw.label}${cutTotal > 0 ? ` - removes GHS ${cutTotal.toFixed(2)} from shop owner(s)` : ""}`
      : ""

  const submit = async () => {
    if (!target || submitting || !confirmed || !amountOk) return
    setSubmitting(true)
    setError(null)
    try {
      const outcome = await postRefundAction(await getToken(), "/api/admin/refunds", "execute", {
        table: target.table, orderId: target.id, gateway, amount: amountNum,
      })
      if (outcome.kind === "error" || outcome.kind === "auth") {
        // Rejected before any money moved (SHORTFALL, 409, ...): keep the dialog open.
        setError(outcome.message)
        return
      }
      onOutcome(outcome)
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  const blocked = !preview || !eligible || !preview.clawback.ok || !gateway || !amountOk || !confirmed || submitting

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
                Paid GHS {preview.order.paid.toFixed(2)} · gateway fee GHS {preview.order.gatewayFee.toFixed(2)} · payer {preview.order.payment.payerPhone ?? "unknown"}
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

            {summary && eligible && (
              <label className="flex items-start gap-2 rounded-md border border-primary/50 p-3">
                <input type="checkbox" className="mt-1" checked={confirmed} disabled={submitting} onChange={(e) => setConfirmed(e.target.checked)} />
                <span><span className="font-medium">{summary}.</span> I confirm this is correct.</span>
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
