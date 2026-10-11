"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { AlertCircle, ChevronLeft, ChevronRight, History } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { smsFetch, type LedgerEntry, type Page } from "../../_lib/api"
import { formatCount, formatDelta, pageCount, timeAgo } from "../../_lib/view"

export function CreditHistory() {
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<LedgerEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)
  const alive = useRef(true)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // Newest request wins; a failed reload keeps the rows already shown.
  const load = useCallback(async (pageNum: number) => {
    const mine = ++seq.current
    const r = await smsFetch<Page<LedgerEntry>>(`/api/sms/ledger?page=${pageNum}`)
    if (!alive.current || mine !== seq.current) return
    if (r.ok && Array.isArray(r.data?.rows)) {
      const t = Number(r.data.total) || 0
      setFailed(false)
      setTotal(t)
      if (r.data.rows.length === 0 && t > 0 && pageNum > pageCount(t)) { setPage(pageCount(t)); return }
      setRows(r.data.rows)
    } else {
      setFailed(true)
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load(page) }, [load, page])

  const pages = pageCount(total)

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Credit History</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {failed && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>Couldn’t load your credit history.{rows.length > 0 ? " Showing the last loaded page." : ""}</span>
              <Button size="sm" variant="outline" onClick={() => { void load(page) }}>Retry</Button>
            </AlertDescription>
          </Alert>
        )}

        {loading && rows.length === 0 ? (
          <div className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
        ) : rows.length === 0 && !failed ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <History className="h-7 w-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No credit activity yet.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const credit = r.delta > 0
              const inner = (
                <div className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.label}</p>
                    <p className="text-xs text-muted-foreground">{timeAgo(r.created_at)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`text-sm font-semibold tabular-nums ${credit ? "text-success" : "text-muted-foreground"}`}>
                      {formatDelta(r.delta)}
                    </p>
                    {r.balance_after !== null && r.balance_after !== undefined && (
                      <p className="text-[11px] text-muted-foreground">Balance {formatCount(r.balance_after)}</p>
                    )}
                  </div>
                </div>
              )
              return (
                <li key={r.id}>
                  {r.send_log_id ? (
                    <Link href={`/dashboard/sms/records/${r.send_log_id}`} className="block rounded-md hover:bg-muted/50">{inner}</Link>
                  ) : inner}
                </li>
              )
            })}
          </ul>
        )}

        {total > 0 && (
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft className="h-4 w-4" /> Previous
            </Button>
            <span className="text-xs text-muted-foreground">Page {page} of {pages}</span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
