"use client"

// Hubtel payments waiting for a person: needs_review rows and confirming rows whose claim went stale.
// Re-check asks Hubtel and shows the answer; Fulfil, Mark failed and Refunded outside the app are decided server-side
// (lib/hubtel-pay/review.ts).

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, HandCoins, Loader2, RefreshCw, Search, XCircle } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { adminFetch } from "../_lib/api"

interface ReviewItem {
  reference: string
  internalReference: string | null
  surface: string
  amountGhs: number
  status: string
  reason: string
  ageMinutes: number
}
interface CheckSummary { kind: string; amountGhs: number | null; chargesGhs: number | null; paymentMethod: string | null }
type Action = "recheck" | "fulfil" | "mark_failed" | "refunded_manually"
interface ManualRefundForm { admin_reference: string; note: string }

const age = (m: number) => (m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`)
const checkText = (c: CheckSummary) =>
  `Hubtel: ${c.kind}${c.amountGhs !== null ? `, GHS ${c.amountGhs.toFixed(2)}` : ""}${c.chargesGhs !== null ? ` (charge ${c.chargesGhs.toFixed(2)})` : ""}${c.paymentMethod ? `, ${c.paymentMethod}` : ""}`

export function NeedsReviewCard() {
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, string>>({})
  const [manualOpen, setManualOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await adminFetch<{ items: ReviewItem[] }>("/api/admin/gateway/hubtel-payments")
      setItems(data.items)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load Hubtel payments")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const act = async (item: ReviewItem, action: Action, form?: ManualRefundForm) => {
    if (action === "fulfil" && !window.confirm(`Fulfil ${item.internalReference ?? item.reference} (GHS ${item.amountGhs.toFixed(2)})? Hubtel is checked again first.`)) return
    if (action === "mark_failed" && !window.confirm("Mark this Hubtel payment failed? The order itself is not changed.")) return
    setBusy(`${item.reference}:${action}`)
    try {
      const res = await fetchAction(item.reference, action, form)
      if (res.check) setChecks((c) => ({ ...c, [item.reference]: checkText(res.check!) }))
      if (res.ok) {
        toast.success(res.message)
        if (action === "refunded_manually") setManualOpen(null)
        if (action !== "recheck") await load()
      } else {
        toast.error(res.message)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 shrink-0 text-primary" /> Hubtel payments to review
          </CardTitle>
          <CardDescription>Payments the system would not decide on its own. Fulfil only runs when Hubtel says Paid in full.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} aria-label="Refresh">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </CardHeader>
      <CardContent>
        {items === null ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Nothing waiting for review.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.reference} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-semibold text-primary">GHS {item.amountGhs.toFixed(2)}</span>
                  <span className="text-xs text-muted-foreground">{item.status.replace("_", " ")} · {age(item.ageMinutes)} old · {item.surface}</span>
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs lg:grid-cols-2">
                  <div className="min-w-0"><dt className="inline text-muted-foreground">Ref </dt><dd className="inline break-all font-mono">{item.reference}</dd></div>
                  <div className="min-w-0"><dt className="inline text-muted-foreground">Order ref </dt><dd className="inline break-all font-mono">{item.internalReference ?? "none"}</dd></div>
                </dl>
                <p className="mt-2 text-sm">{item.reason}</p>
                {checks[item.reference] && <p className="mt-1 text-xs font-medium text-primary">{checks[item.reference]}</p>}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <ActionButton label="Re-check" icon={<Search className="h-4 w-4" />} busy={busy === `${item.reference}:recheck`} disabled={!!busy} onClick={() => act(item, "recheck")} />
                  <ActionButton label="Fulfil" primary icon={<CheckCircle2 className="h-4 w-4" />} busy={busy === `${item.reference}:fulfil`} disabled={!!busy} onClick={() => act(item, "fulfil")} />
                  <ActionButton label="Mark failed" icon={<XCircle className="h-4 w-4" />} busy={busy === `${item.reference}:mark_failed`} disabled={!!busy} onClick={() => act(item, "mark_failed")} />
                </div>
                {item.status === "needs_review" && (
                  manualOpen === item.reference ? (
                    <ManualRefundFields
                      reference={item.reference}
                      busy={busy === `${item.reference}:refunded_manually`}
                      disabled={!!busy}
                      onCancel={() => setManualOpen(null)}
                      onSubmit={(form) => act(item, "refunded_manually", form)}
                    />
                  ) : (
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setManualOpen(item.reference)} className="mt-2 w-full border-primary/40 px-2 text-primary hover:text-primary">
                      <HandCoins className="h-4 w-4" />
                      <span className="ml-1 truncate">Refunded outside the app</span>
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ActionButton(p: { label: string; icon: React.ReactNode; busy: boolean; disabled: boolean; primary?: boolean; onClick: () => void }) {
  return (
    <Button size="sm" variant={p.primary ? "default" : "outline"} disabled={p.disabled} onClick={p.onClick} className="w-full px-2">
      {p.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : p.icon}
      <span className="ml-1 truncate">{p.label}</span>
    </Button>
  )
}

/** Records a second payment an admin already paid back by hand. Sits under its row so it can't be read as about another. */
function ManualRefundFields(p: { reference: string; busy: boolean; disabled: boolean; onCancel: () => void; onSubmit: (form: ManualRefundForm) => void }) {
  const [adminReference, setAdminReference] = useState("")
  const [note, setNote] = useState("")
  const ready = adminReference.trim().length >= 4 && note.trim().length >= 3
  const refId = `manual-ref-${p.reference}`
  const noteId = `manual-note-${p.reference}`
  return (
    <form
      className="mt-2 space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !p.disabled) p.onSubmit({ admin_reference: adminReference, note })
      }}
    >
      <p className="text-sm">
        <span className="font-semibold text-primary">This moves no money.</span> Pay the customer back first, then record it here. Only for a second payment on an order something else already paid.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={refId}>MoMo or Hubtel reference</Label>
          <Input id={refId} value={adminReference} maxLength={100} autoComplete="off" onChange={(e) => setAdminReference(e.target.value)} />
        </div>
        <div className="min-w-0 space-y-1.5 lg:col-span-2">
          <Label htmlFor={noteId}>Note</Label>
          <Textarea id={noteId} value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} placeholder="Why, and how it was paid back. No phone numbers." />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="sm" variant="outline" disabled={p.disabled} onClick={p.onCancel} className="w-full px-2">Cancel</Button>
        <Button type="submit" size="sm" disabled={p.disabled || !ready} className="w-full px-2">
          {p.busy && <Loader2 className="h-4 w-4 animate-spin" />}
          <span className={p.busy ? "ml-1 truncate" : "truncate"}>Record refund</span>
        </Button>
      </div>
    </form>
  )
}

/** adminFetch throws on non-2xx; here a refusal is an answer to show, with the status check it was based on. */
async function fetchAction(reference: string, action: Action, form?: ManualRefundForm): Promise<{ ok: boolean; message: string; check?: CheckSummary | null }> {
  try {
    const data = await adminFetch<{ message: string; check?: CheckSummary | null }>("/api/admin/gateway/hubtel-payments", { method: "POST", body: { action, reference, ...form } })
    return { ok: true, message: data.message, check: data.check }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Request failed" }
  }
}
