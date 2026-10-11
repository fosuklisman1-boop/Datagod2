"use client"
import { useEffect, useState } from "react"
import { Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, type MessageRow, type Page } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { formatCount, messageBreakdown, shouldResetPage, timeAgo } from "../_lib/view"
import { CopyButton, EmptyState, ErrorBox, LoadingRows, Pager, StatusBadge } from "./ui-bits"

const STATUSES = ["queued", "sending", "sent", "partial", "failed", "blocked", "held", "scheduled"]

export default function MessagesTab() {
  const [text, setText] = useState("")
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("")
  const [page, setPage] = useState(1)

  useEffect(() => {
    const t = setTimeout(() => { setQ(text.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [text])

  const { data, error, loading, reload } = useLoad<Page<MessageRow>>(
    () => api<Page<MessageRow>>(`/api/admin/sms-platform/messages?q=${encodeURIComponent(q)}&status=${status}&page=${page}`), [q, status, page])

  // A narrower search/filter can leave the current page empty: jump back to page 1.
  useEffect(() => {
    if (data && shouldResetPage(page, data.rows.length)) setPage(1)
  }, [data, page])

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search sender, message or user ID" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Select value={status || "all"} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setPage(1) }}>
          <SelectTrigger className="w-full sm:w-44"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading && !data ? <LoadingRows rows={4} /> : error && !data ? <ErrorBox message={error} onRetry={reload} />
        : !data || data.rows.length === 0 ? <EmptyState title="No messages found" hint={q || status ? "Try a different search or filter." : undefined} />
        : (<>
          {error && <ErrorBox message={error} onRetry={reload} />}
          <div className="space-y-3">
            {data.rows.map((m) => {
              const breakdown = messageBreakdown(m)
              return (
                <Card key={m.id} className="clay border-0 py-0">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all font-mono text-sm font-semibold">{m.sender_id ?? "Platform sender"}</span>
                      {m.mode && <Badge variant="outline">{m.mode === "business" ? "Business" : "Platform"}</Badge>}
                      <StatusBadge status={m.status} />
                      <span className="ml-auto text-xs text-muted-foreground">{formatCount(m.recipients_count)} recipients · {timeAgo(m.created_at)}</span>
                    </div>
                    <p className="clay-inset line-clamp-5 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm">{m.message}</p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">User <span className="font-mono">{m.user_id.slice(0, 8)}…</span><CopyButton value={m.user_id} title="Copy user ID" /></span>
                      <span>{formatCount(m.credits_used)} credits used · {m.segments} segment{m.segments === 1 ? "" : "s"}</span>
                      {breakdown && <span>{breakdown}</span>}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>)}
    </div>
  )
}
