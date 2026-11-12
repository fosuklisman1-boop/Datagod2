"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, RefreshCw, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  mergeThreadList,
  needsOwnershipCheck,
  previewText,
  threadMatchesSearch,
  userDisplayName,
  type AdminThreadListItem,
} from "@/lib/support-admin-client"
import { cn } from "@/lib/utils"
import { adminApi, usePolling } from "./support-api"
import { ConversationDialog } from "./conversation-dialog"
import { formatDateTime } from "./order-details-dialog"

const LIST_POLL_MS = 180_000
const selectCls = "h-10 rounded-md border border-input bg-background px-3 text-sm"

interface Counts {
  openThreads: number
  unreadMessages: number
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  )
}

function UnreadBubble({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
      {count}
    </span>
  )
}

function UnlinkedBadge() {
  return (
    <Badge variant="outline" className="shrink-0 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400">
      Order not linked - verify ownership
    </Badge>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <Badge variant={status === "open" ? "default" : "secondary"}>{status === "open" ? "Open" : "Closed"}</Badge>
}

export function ThreadsTab() {
  const [threads, setThreads] = useState<AdminThreadListItem[]>([])
  const [counts, setCounts] = useState<Counts | null>(null)
  const [status, setStatus] = useState<"open" | "closed" | "all">("open")
  const [days, setDays] = useState("30")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const zeroed = useRef<Set<string>>(new Set())
  const inFlight = useRef(false)
  const wanted = useRef({ status, days })
  const queued = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    queued.current = false
    const { status: s, days: d } = wanted.current
    try {
      const [list, c] = await Promise.all([
        adminApi<{ threads: AdminThreadListItem[] }>(`/api/admin/support/threads?status=${s}&days=${d}`),
        adminApi<Counts>("/api/admin/support/counts"),
      ])
      // A filter changed while this request was out: drop it, the effect refetches.
      if (wanted.current.status !== s || wanted.current.days !== d) return
      if (list.ok && list.data) {
        setThreads((prev) => {
          const merged = mergeThreadList(prev, list.data!.threads, zeroed.current)
          zeroed.current = merged.zeroed
          return merged.threads
        })
        setError(null)
      } else {
        setError(list.error ?? "Could not load complaints")
      }
      if (c.ok && c.data) setCounts(c.data)
    } finally {
      inFlight.current = false
      setLoading(false)
      // A reply/close/read finished while this request was out: its result may be stale.
      if (queued.current) void refresh()
    }
  }, [])

  /** Refresh after a change the admin made; runs once the current request (if any) ends. */
  const refreshAfterChange = useCallback(() => {
    queued.current = true
    if (!inFlight.current) void refresh()
  }, [refresh])

  useEffect(() => {
    wanted.current = { status, days }
    setLoading(true)
    // A request from the previous filter may still be in flight; let it finish, then fetch.
    const start = () => {
      if (inFlight.current) {
        setTimeout(start, 150)
        return
      }
      void refresh()
    }
    start()
  }, [status, days, refresh])

  usePolling(refresh, LIST_POLL_MS, true)

  const visible = useMemo(() => threads.filter((t) => threadMatchesSearch(t, search)), [threads, search])

  function openThread(id: string) {
    zeroed.current.add(id)
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, unread_count: 0 } : t)))
    setSelectedId(id)
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:gap-4">
        <StatCard label="Open complaints" value={counts?.openThreads ?? "—"} />
        <StatCard label="Unread messages" value={counts?.unreadMessages ?? "—"} />
        <StatCard label="In view" value={visible.length} />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, subject, phone or order reference"
            className="pl-9"
          />
        </div>
        <select aria-label="Status" className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <select aria-label="Window" className={selectCls} value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
        <Button type="button" variant="outline" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading && threads.length === 0 ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : visible.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No complaints match these filters.</p>
      ) : (
        <>
          <div className="hidden lg:block">
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Last message</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last activity</TableHead>
                    <TableHead>Order</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((t) => (
                    <TableRow key={t.id} className="cursor-pointer" onClick={() => openThread(t.id)}>
                      <TableCell className="max-w-[240px]">
                        <div className="flex items-center gap-2">
                          <span className={cn("truncate", t.unread_count > 0 && "font-bold")}>{t.subject}</span>
                          <UnreadBubble count={t.unread_count} />
                        </div>
                        {needsOwnershipCheck(t) && (
                          <div className="mt-1">
                            <UnlinkedBadge />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <p className="truncate text-sm font-medium">{userDisplayName(t.user)}</p>
                        <p className="truncate text-xs text-muted-foreground">{t.user?.email}</p>
                      </TableCell>
                      <TableCell className="max-w-[260px] truncate text-sm text-muted-foreground">{previewText(t.last_message)}</TableCell>
                      <TableCell>
                        <StatusBadge status={t.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{formatDateTime(t.last_message_at)}</TableCell>
                      <TableCell className="text-sm">{t.order?.reference ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>

          <div className="space-y-2 lg:hidden">
            {visible.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => openThread(t.id)}
                className="w-full rounded-xl border border-border bg-card p-3 text-left transition hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className={cn("min-w-0 break-words text-sm", t.unread_count > 0 ? "font-bold" : "font-medium")}>{t.subject}</p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <UnreadBubble count={t.unread_count} />
                    <StatusBadge status={t.status} />
                  </div>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {userDisplayName(t.user)}
                  {t.user?.email ? ` · ${t.user.email}` : ""}
                </p>
                {needsOwnershipCheck(t) && (
                  <div className="mt-1">
                    <UnlinkedBadge />
                  </div>
                )}
                <p className="mt-1 truncate text-sm text-muted-foreground">{previewText(t.last_message)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDateTime(t.last_message_at)}
                  {t.order?.reference ? ` · ${t.order.reference}` : ""}
                </p>
              </button>
            ))}
          </div>
        </>
      )}

      <ConversationDialog threadId={selectedId} onClose={() => setSelectedId(null)} onChanged={refreshAfterChange} />
    </div>
  )
}
