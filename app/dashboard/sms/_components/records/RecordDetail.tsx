"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { AlertCircle, ArrowLeft, CalendarClock, Clock, Loader2 } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { smsFetch } from "../../_lib/api"
import { ORDER_CONFIRMATION_TAG, formatCount, formatScheduled, isCancelledLog, isInFlight, isOrderConfirmation, recipientErrorText, recipientStatus, toneBadgeClass } from "../../_lib/view"
import { StatusBadge } from "./StatusBadge"
import { CancelScheduledButton } from "./CancelScheduledButton"
import type { RecordRow } from "./RecordsList"

interface MessageRow {
  id: string; phone: string; status: string; attempts: number
  last_error: string | null; processed_at: string | null
  delivery_status: string | null; refunded: boolean | null
}
interface Counts { delivered: number; failed: number; pending: number; refunded: number }
interface Detail { log: RecordRow; messages: MessageRow[]; counts: Counts }

const POLL_MS = 5000

export function RecordDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)
  const alive = useRef(true)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    const mine = ++seq.current
    const r = await smsFetch<Detail>(`/api/sms/logs/${encodeURIComponent(id)}`)
    if (!alive.current || mine !== seq.current) return
    if (r.ok && r.data?.log) { setDetail(r.data); setFailed(false); setNotFound(false) }
    else if (r.status === 404 || r.status === 400) setNotFound(true)
    else setFailed(true)
    setLoading(false)
  }, [id])

  useEffect(() => { setLoading(true); setDetail(null); void load() }, [load])

  const inFlight = !!detail && isInFlight(detail.log.status)
  useEffect(() => {
    if (!inFlight) return
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(t)
  }, [inFlight, load])

  const back = (
    <Link href="/dashboard/sms/records" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> All records
    </Link>
  )

  if (loading && !detail) {
    return <div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-24 w-full" /><Skeleton className="h-48 w-full" /></div>
  }

  if (!detail) {
    return (
      <div className="space-y-4">
        {back}
        <Alert variant={notFound ? "default" : "destructive"}>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{notFound ? "We couldn’t find that campaign." : "Couldn’t load this campaign."}</span>
            {!notFound && failed && <Button size="sm" variant="outline" onClick={() => { setLoading(true); void load() }}>Retry</Button>}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const { log, messages, counts } = detail
  const scheduled = log.status === "scheduled"
  const held = log.status === "held" || scheduled // neither has delivery data yet
  const cancelled = isCancelledLog(log)
  // Cancelling marks every message failed + refunded, so the Failed card would mislead.
  const cards: { label: string; value: number; cls: string }[] = [
    { label: "Delivered", value: counts.delivered, cls: "text-emerald-600 dark:text-emerald-300" },
    ...(cancelled ? [] : [{ label: "Failed", value: counts.failed, cls: "text-red-600 dark:text-red-300" }]),
    { label: "Pending", value: counts.pending, cls: "text-foreground" },
    { label: "Refunded", value: counts.refunded, cls: "text-muted-foreground" },
  ]

  return (
    <div className="space-y-5">
      {back}

      {failed && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Couldn’t refresh. Showing the last loaded data.</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">Campaign #{log.id}</h2>
          <StatusBadge status={log.status} cancelled={log.cancelled} />
          {isOrderConfirmation(log) && <Badge variant="outline" className={toneBadgeClass("info")}>{ORDER_CONFIRMATION_TAG}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          {formatCount(log.recipients_count)} recipient{log.recipients_count === 1 ? "" : "s"} · {formatCount(log.credits_used)}/{formatCount(log.credits_reserved)} credits used · from {log.sender_id || "default sender"} · {new Date(log.created_at).toLocaleString()}
        </p>
        <div className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm">{log.message}</div>
      </div>

      {log.status === "held" && (
        <Alert className="border-warning/30 bg-warning/10">
          <Clock className="h-4 w-4" />
          <AlertDescription>Under review — we’ll notify you. Nothing more is needed from you.</AlertDescription>
        </Alert>
      )}

      {cancelled && (
        <Alert>
          <AlertDescription>Cancelled before sending — {formatCount(log.credits_reserved)} credit{log.credits_reserved === 1 ? "" : "s"} refunded.</AlertDescription>
        </Alert>
      )}

      {scheduled && (
        <Alert>
          <CalendarClock className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Scheduled for {log.scheduled_for ? formatScheduled(log.scheduled_for) : "a later time"}. Credits are reserved; you can cancel until then.
            </span>
            <CancelScheduledButton id={log.id} onDone={() => { void load() }} />
          </AlertDescription>
        </Alert>
      )}

      {!held && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map((c) => (
            <Card key={c.label}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className={`text-2xl font-bold ${c.cls}`}>{formatCount(c.value)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {inFlight && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Still sending — this updates automatically.
        </p>
      )}

      {!held && (messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recipient details yet.</p>
      ) : (
        <>
          {/* Phones: stacked cards */}
          <ul className="space-y-2 md:hidden">
            {messages.map((m) => {
              const s = recipientStatus(m)
              return (
                <li key={m.id} className="rounded-lg border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm">{m.phone}</span>
                    <Badge variant="outline" className={toneBadgeClass(s.tone)}>{s.label}</Badge>
                  </div>
                  {m.last_error && (s.label === "Failed" || s.label === "Refunded") && <p className="mt-1 break-words text-xs text-muted-foreground">{recipientErrorText(m.last_error)}</p>}
                </li>
              )
            })}
          </ul>
          {/* Larger screens: table */}
          <div className="hidden overflow-x-auto rounded-md border md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Number</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => {
                  const s = recipientStatus(m)
                  return (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="px-3 py-2 font-mono">{m.phone}</td>
                      <td className="px-3 py-2"><Badge variant="outline" className={toneBadgeClass(s.tone)}>{s.label}</Badge></td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{s.label === "Failed" || s.label === "Refunded" ? recipientErrorText(m.last_error) : ""}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      ))}
    </div>
  )
}
