"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Loader2, ScrollText, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { sanitizeV1Search, type ConsoleKey } from "@/lib/api-v2/admin-view"
import { createLatestGate } from "@/lib/api-v2/latest-gate"
import { adminFetch } from "./admin-fetch"
import { LogTable, type LogRow } from "./LogTable"
import { InlineError, Segmented } from "./ui"

const PAGE = 50
type Source = "v2" | "v1"
type StatusClass = "all" | "success" | "client_error" | "server_error"

const str = (v: unknown) => (typeof v === "string" && v ? v : null)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** Picks display fields only, so payload columns from the v1 route never reach the UI. */
function toRow(r: Record<string, unknown>, src: Source): LogRow {
  const key = (r.key ?? {}) as Record<string, unknown>
  const user = (r.user ?? {}) as Record<string, unknown>
  return {
    id: String(r.id),
    method: str(r.method) ?? "—",
    endpoint: str(r.endpoint) ?? "—",
    status: num(r.status_code) ?? 0,
    ms: num(r.duration_ms),
    ip: str(r.ip_address),
    time: str(r.created_at) ?? "",
    keyPrefix: src === "v2" ? str(r.key_prefix) : str(key.key_prefix),
    email: src === "v2" ? str(r.owner_email) : str(user.email),
  }
}

export function RequestLogs({ keys, preset }: { keys: ConsoleKey[]; preset?: { rows: LogRow[]; total: number } }) {
  const [source, setSource] = useState<Source>("v2")
  const [statusClass, setStatusClass] = useState<StatusClass>("all")
  const [search, setSearch] = useState("")
  const [keyId, setKeyId] = useState("all")
  const [offset, setOffset] = useState(0)
  const [rows, setRows] = useState<LogRow[]>(preset?.rows ?? [])
  const [total, setTotal] = useState<number | null>(preset?.total ?? null)
  const [loading, setLoading] = useState(!preset)
  const [error, setError] = useState<string | null>(null)
  const gate = useRef(createLatestGate())

  const load = useCallback(async () => {
    if (preset) return
    setLoading(true)
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    let url: string
    if (source === "v2") {
      if (statusClass !== "all") p.set("statusClass", statusClass)
      if (search.trim()) p.set("endpoint", search.trim().slice(0, 200))
      if (keyId !== "all") p.set("keyId", keyId)
      url = `/api/admin/api-v2/logs?${p}`
    } else {
      if (statusClass !== "all") p.set("statusFilter", statusClass)
      // Stopgap: /api/admin/api-logs puts `search` unescaped into a PostgREST .or() filter,
      // so strip the characters that could add clauses (`,` `(` `)`) before sending.
      const q = sanitizeV1Search(search)
      if (q) p.set("search", q)
      if (keyId !== "all") p.set("apiKeyId", keyId)
      url = `/api/admin/api-logs?${p}`
    }
    const ticket = gate.current.next()
    const r = await adminFetch<{ logs?: Record<string, unknown>[]; total?: number }>(url)
    if (!gate.current.isLatest(ticket)) return // a newer filter/page request superseded this one
    if (r.ok) {
      const list = Array.isArray(r.data?.logs) ? r.data.logs : []
      setRows(list.map((x) => toRow(x, source)))
      setTotal(source === "v2" && typeof r.data?.total === "number" ? r.data.total : null)
      setError(null)
    } else {
      setRows([])
      setError(r.error)
    }
    setLoading(false)
  }, [preset, source, statusClass, search, keyId, offset])

  useEffect(() => {
    const t = setTimeout(() => void load(), 350)
    return () => clearTimeout(t)
  }, [load])

  const resetPage = () => setOffset(0)
  const sourceKeys = keys.filter((k) => k.source === source)
  const selectedKey = sourceKeys.find((k) => k.id === keyId)
  const statusLabels: Record<StatusClass, string> = {
    all: "All statuses",
    success: source === "v2" ? "2xx/3xx success" : "2xx success",
    client_error: "4xx client error",
    server_error: "5xx server error",
  }
  const hasMore = total !== null ? offset + rows.length < total : rows.length === PAGE

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <Segmented<Source>
          label="Log source"
          value={source}
          onChange={(v) => {
            setSource(v)
            setKeyId("all")
            resetPage()
          }}
          options={[
            { value: "v2", label: "v2" },
            { value: "v1", label: "Legacy v1" },
          ]}
          className="w-full lg:w-auto"
        />
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              resetPage()
            }}
            placeholder={source === "v2" ? "Filter by endpoint, e.g. /wallet" : "Search endpoint, method or IP..."}
            aria-label="Search logs"
            className="h-10 rounded-xl bg-card pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 lg:w-[380px]">
          <Select value={statusClass} onValueChange={(v) => { setStatusClass(v as StatusClass); resetPage() }}>
            <SelectTrigger aria-label="Filter by status" className="h-10 w-full rounded-xl bg-card">
              <SelectValue>{statusLabels[statusClass]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(statusLabels) as StatusClass[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={keyId} onValueChange={(v) => { setKeyId(v); resetPage() }}>
            <SelectTrigger aria-label="Filter by key" className="h-10 w-full min-w-0 rounded-xl bg-card">
              <SelectValue>
                <span className="truncate">{selectedKey ? `${selectedKey.prefix}… ${selectedKey.ownerName}` : "All keys"}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All keys</SelectItem>
              {sourceKeys.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  <span className="font-mono">{k.prefix}…</span> {k.ownerName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && <InlineError message={`Could not load logs: ${error}`} onRetry={() => void load()} />}

      {loading && rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-border py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading logs…
        </div>
      ) : rows.length === 0 && !error ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-4 py-12 text-center">
          <ScrollText className="size-6 text-muted-foreground" aria-hidden />
          <p className="font-medium text-foreground">No requests match these filters</p>
          <p className="text-sm text-muted-foreground">Requests appear here as soon as a key calls the API.</p>
        </div>
      ) : rows.length > 0 ? (
        <LogTable rows={rows} />
      ) : null}

      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {rows.length > 0 ? `${offset + 1}–${offset + rows.length}` : "0"}
          {total !== null ? ` of ${total.toLocaleString("en-US")}` : ""}
        </span>
        <div className="flex gap-2">
          <button type="button" aria-label="Previous page" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-card disabled:opacity-40">
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button type="button" aria-label="Next page" disabled={!hasMore || loading} onClick={() => setOffset(offset + PAGE)} className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-card disabled:opacity-40">
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  )
}
