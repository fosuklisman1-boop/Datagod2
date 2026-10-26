"use client"

import { useState } from "react"
import { toast } from "sonner"
import { CheckCircle2, Loader2, Send } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { prizeSummary, type PrizeRow, type PrizeType } from "@/lib/leaderboard/prizes"
import type { AdminResultRow, DeliveryView } from "@/lib/leaderboard/admin"
import { leaderboardFetch } from "../api"

const STATUS: Record<DeliveryView["status"], { label: string; className: string }> = {
  not_started: { label: "Not sent", className: "bg-muted text-muted-foreground" },
  in_progress: { label: "Sending…", className: "bg-primary/15 text-primary" },
  sent: { label: "Sent: waiting for the order", className: "bg-warning/15 text-warning" },
  delivered: { label: "Delivered", className: "bg-success/15 text-success" },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive" },
}

const NEEDS_PHONE: PrizeType[] = ["data_bundle", "airtime"]
const BOARD_SHORT = { dashboard: "Dashboard", shop: "Shop" } as const

interface Props {
  results: AdminResultRow[]
  deliveries: Record<string, DeliveryView>
  prizes: PrizeRow[]
  onChanged: () => void
}

/** Delivery tab: one row per winner with a prize. Only rendered for a period closed with rewards. */
export function DeliveryPanel({ results, deliveries, prizes, onChanged }: Props) {
  const winners = results.filter((r) => r.prize)
  const [phones, setPhones] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [marking, setMarking] = useState<AdminResultRow | null>(null)
  const [note, setNote] = useState("")

  const prizeOf = (r: AdminResultRow) => prizes.find((p) => p.id === r.prize!.id)
  const stateOf = (r: AdminResultRow): DeliveryView["status"] => deliveries[r.id]?.status ?? "not_started"
  const sendable = (r: AdminResultRow) => {
    const p = prizeOf(r)
    const s = stateOf(r)
    return !!p && p.status === "active" && p.prize_type !== "manual" && (s === "not_started" || s === "failed")
  }

  async function deliver(r: AdminResultRow): Promise<boolean> {
    setBusy(r.id)
    const phone = phones[r.id]
    const res = await leaderboardFetch<{ message: string }>("/api/admin/leaderboard/deliver", {
      method: "POST",
      body: { result_id: r.id, ...(phone ? { phone } : {}) },
    })
    setBusy(null)
    if (res.ok) toast.success(`${r.fullName}: ${res.data.message}`)
    else toast.error(`${r.fullName}: ${res.error}`)
    return res.ok
  }

  async function deliverAll() {
    const queue = winners.filter(sendable)
    let sent = 0
    for (const r of queue) if (await deliver(r)) sent++
    toast.message(`Delivered ${sent} of ${queue.length} prizes`)
    onChanged()
  }

  async function markDelivered() {
    if (!marking) return
    setBusy(marking.id)
    const res = await leaderboardFetch("/api/admin/leaderboard/deliver/mark", { method: "POST", body: { result_id: marking.id, note } })
    setBusy(null)
    if (!res.ok) return toast.error(res.error)
    toast.success("Marked as delivered")
    setMarking(null)
    setNote("")
    onChanged()
  }

  if (winners.length === 0) {
    return <p className="text-sm text-muted-foreground">No prizes to deliver for this period.</p>
  }

  const pending = winners.filter(sendable).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Cash and dealer upgrades arrive at once. Data and airtime become normal orders and show as delivered once they complete.
        </p>
        <Button onClick={deliverAll} disabled={!!busy || pending === 0}>
          <Send className="h-4 w-4" /> Deliver all ({pending})
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Winners</CardTitle>
          <CardDescription>Each prize can only be sent once. A failed one can be tried again.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {winners.map((r) => {
            const prize = prizeOf(r)
            const d = deliveries[r.id]
            const state = stateOf(r)
            const cancelled = prize?.status === "cancelled"
            const needsPhone = !!prize && NEEDS_PHONE.includes(prize.prize_type)
            return (
              <div key={r.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{BOARD_SHORT[r.board]} #{r.rank} · {r.fullName}</p>
                    <p className="text-sm text-foreground">{prize ? prizeSummary(prize) : r.prize!.label}</p>
                    <p className="truncate text-xs text-muted-foreground">{[r.email, r.phone].filter(Boolean).join(" · ")}</p>
                  </div>
                  {cancelled ? (
                    <Badge variant="outline">Cancelled</Badge>
                  ) : (
                    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", STATUS[state].className)}>{STATUS[state].label}</span>
                  )}
                </div>

                {d?.lastError && state === "failed" && <p className="text-sm text-destructive">{d.lastError}</p>}
                {d?.note && <p className="text-xs text-muted-foreground">Note: {d.note}</p>}
                {d?.orderId && (
                  <p className="text-xs text-muted-foreground">
                    {d.orderTable === "airtime_orders" ? "Airtime" : "Data"} order {d.orderId.slice(0, 8)} · {d.orderStatus ?? "unknown"}
                    {d.recipientPhone ? ` · to ${d.recipientPhone}` : ""}
                  </p>
                )}

                {!cancelled && state !== "delivered" && state !== "sent" && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    {needsPhone && !d?.orderId && (
                      <Input
                        className="sm:max-w-[200px]"
                        inputMode="tel"
                        value={phones[r.id] ?? d?.recipientPhone ?? r.phone ?? ""}
                        onChange={(e) => setPhones((p) => ({ ...p, [r.id]: e.target.value }))}
                        placeholder="Recipient phone"
                        aria-label={`Recipient phone for ${r.fullName}`}
                      />
                    )}
                    {prize?.prize_type !== "manual" && (
                      <Button size="sm" onClick={async () => { await deliver(r); onChanged() }} disabled={!!busy || state === "in_progress"}>
                        {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        {state === "failed" ? "Try again" : "Deliver"}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setMarking(r)} disabled={!!busy || state === "in_progress"}>
                      <CheckCircle2 className="h-4 w-4" /> Mark delivered
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Dialog open={!!marking} onOpenChange={(o) => { if (!o) { setMarking(null); setNote("") } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark as delivered</DialogTitle>
            <DialogDescription>
              {marking && `${marking.fullName} · ${marking.prize?.label}`}. Use this once you have given the prize yourself. Nothing is sent.
            </DialogDescription>
          </DialogHeader>
          <Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. collected in person on 3 Nov" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMarking(null)} disabled={!!busy}>Back</Button>
            <Button onClick={markDelivered} disabled={!!busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Mark delivered
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
