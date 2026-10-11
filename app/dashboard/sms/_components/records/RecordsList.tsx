"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { AlertCircle, ChevronLeft, ChevronRight, History, Loader2, RefreshCw, Send } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { smsFetch } from "../../_lib/api"
import { RECORD_CHIPS, chipStatus, formatCount, isInFlight, pageCount, timeAgo } from "../../_lib/view"
import { StatusBadge } from "./StatusBadge"

export interface RecordRow {
  id: number | string
  status: string
  message: string
  sender_id: string | null
  recipients_count: number
  segments: number
  credits_reserved: number
  credits_used: number
  created_at: string
  completed_at: string | null
}
interface RecordsPage { logs: RecordRow[]; total: number; page: number; pageSize: number }

const POLL_MS = 7000

export function RecordsList() {
  const [chip, setChip] = useState("all")
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<RecordRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)
  const alive = useRef(true)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // Newest request wins; stale responses are dropped. A failed reload keeps the rows already shown.
  const load = useCallback(async (chipKey: string, pageNum: number) => {
    const mine = ++seq.current
    const qs = new URLSearchParams({ page: String(pageNum) })
    qs.set("status", chipStatus(chipKey))
    const r = await smsFetch<RecordsPage>(`/api/sms/logs?${qs.toString()}`)
    if (!alive.current || mine !== seq.current) return
    if (r.ok && Array.isArray(r.data?.logs)) {
      const t = Number(r.data.total) || 0
      setFailed(false)
      setTotal(t)
      // Page past the end (rows were removed / filter changed): snap back to the last real page.
      if (r.data.logs.length === 0 && t > 0 && pageNum > pageCount(t)) { setPage(pageCount(t)); return }
      setRows(r.data.logs)
    } else {
      setFailed(true)
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load(chip, page) }, [load, chip, page])

  const anyInFlight = rows.some((l) => isInFlight(l.status))
  useEffect(() => {
    if (!anyInFlight) return
    const t = setInterval(() => { void load(chip, page) }, POLL_MS)
    return () => clearInterval(t)
  }, [anyInFlight, load, chip, page])

  const pages = pageCount(total)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter by status">
          {RECORD_CHIPS.map((c) => (
            <Button
              key={c.key} size="sm" role="tab" aria-selected={chip === c.key}
              variant={chip === c.key ? "default" : "outline"}
              onClick={() => { if (c.key !== chip) { setChip(c.key); setPage(1); setLoading(true) } }}
            >
              {c.label}
            </Button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => { void load(chip, page) }}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {failed && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>Couldn’t load your records.{rows.length > 0 ? " Showing the last loaded list." : ""}</span>
            <Button size="sm" variant="outline" onClick={() => { void load(chip, page) }}>Retry</Button>
          </AlertDescription>
        </Alert>
      )}

      {loading && rows.length === 0 ? (
        <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
      ) : rows.length === 0 && !failed ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <History className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {chip === "all" ? "You haven’t sent any SMS yet." : "No campaigns with this status."}
            </p>
            {chip === "all" ? (
              <Button asChild><Link href="/dashboard/sms/compose"><Send className="h-4 w-4" /> Send your first SMS</Link></Button>
            ) : (
              <Button variant="outline" onClick={() => { setChip("all"); setPage(1) }}>Show all</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {anyInFlight && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Updating automatically while sends are in progress…
            </p>
          )}
          <ul className="space-y-3">
            {rows.map((l) => (
              <li key={l.id}>
                <Link href={`/dashboard/sms/records/${l.id}`} className="block rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50">
                  <div className="flex items-start justify-between gap-3">
                    <p className="line-clamp-2 min-w-0 break-words text-sm font-medium text-foreground">{l.message}</p>
                    <StatusBadge status={l.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{formatCount(l.recipients_count)} recipient{l.recipients_count === 1 ? "" : "s"}</span>
                    <span>{formatCount(l.credits_used)}/{formatCount(l.credits_reserved)} credits</span>
                    <span title={new Date(l.created_at).toLocaleString()}>{timeAgo(l.created_at)}</span>
                    <span>#{l.id}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {pages > 1 && (
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-4 w-4" /> Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {page} of {pages} · {formatCount(total)} total</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
