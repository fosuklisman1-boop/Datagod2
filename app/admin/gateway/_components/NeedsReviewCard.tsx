"use client"

// Hubtel payments waiting for a person: needs_review rows and confirming rows whose claim went stale.
// Re-check asks Hubtel and shows the answer; Fulfil and Mark failed are decided server-side (lib/hubtel-pay/review.ts).

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Search, XCircle } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
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
type Action = "recheck" | "fulfil" | "mark_failed"

const age = (m: number) => (m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`)
const checkText = (c: CheckSummary) =>
  `Hubtel: ${c.kind}${c.amountGhs !== null ? `, GHS ${c.amountGhs.toFixed(2)}` : ""}${c.chargesGhs !== null ? ` (charge ${c.chargesGhs.toFixed(2)})` : ""}${c.paymentMethod ? `, ${c.paymentMethod}` : ""}`

export function NeedsReviewCard() {
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, string>>({})

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

  const act = async (item: ReviewItem, action: Action) => {
    if (action === "fulfil" && !window.confirm(`Fulfil ${item.internalReference ?? item.reference} (GHS ${item.amountGhs.toFixed(2)})? Hubtel is checked again first.`)) return
    if (action === "mark_failed" && !window.confirm("Mark this Hubtel payment failed? The order itself is not changed.")) return
    setBusy(`${item.reference}:${action}`)
    try {
      const res = await fetchAction(item.reference, action)
      if (res.check) setChecks((c) => ({ ...c, [item.reference]: checkText(res.check!) }))
      if (res.ok) {
        toast.success(res.message)
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

/** adminFetch throws on non-2xx; here a refusal is an answer to show, with the status check it was based on. */
async function fetchAction(reference: string, action: Action): Promise<{ ok: boolean; message: string; check?: CheckSummary | null }> {
  try {
    const data = await adminFetch<{ message: string; check?: CheckSummary | null }>("/api/admin/gateway/hubtel-payments", { method: "POST", body: { action, reference } })
    return { ok: true, message: data.message, check: data.check }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Request failed" }
  }
}
