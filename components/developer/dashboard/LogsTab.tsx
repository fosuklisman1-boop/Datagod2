"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ScrollText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Eyebrow, IconChip, InlineError, Panel, TONE_CHIP } from "@/components/admin/api-keys/ui"
import { httpTone, latestGate, reasonLabel, shortTime } from "@/lib/api-v2/dev-dashboard-view"
import type { V2KeySummary } from "@/lib/api-v2/key-slots"
import { cn } from "@/lib/utils"
import { dashJson } from "./dash-fetch"

interface LogRow {
  id: string
  created_at: string
  method: string | null
  endpoint: string | null
  status: number
  reason: string | null
  duration_ms: number | null
  environment: string | null
  ip: string | null
  key_id: string | null
}

const selectCls = "h-9 rounded-xl border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function LogsTab() {
  const [keys, setKeys] = useState<V2KeySummary[]>([])
  const [key, setKey] = useState("")
  const [env, setEnv] = useState("")
  const [status, setStatus] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [rows, setRows] = useState<LogRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void dashJson<{ keys?: V2KeySummary[] }>("/api/user/v2-keys").then((r) => {
      if (r.ok && Array.isArray(r.data.keys)) setKeys(r.data.keys)
    })
  }, [])
  const keyLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const k of keys) m.set(k.id, `${k.environment === "live" ? "Live" : "Test"} ${k.key_type} · ${k.key_prefix}…`)
    return m
  }, [keys])

  const query = useCallback(
    (before: string | null) => {
      const p = new URLSearchParams()
      if (key) p.set("key", key)
      if (env) p.set("env", env)
      if (status) p.set("status", status)
      if (from) p.set("from", from)
      if (to) p.set("to", to)
      if (before) p.set("before", before)
      return `/api/user/v2-dashboard/logs?${p.toString()}`
    },
    [key, env, status, from, to],
  )

  const gate = useRef(latestGate())
  const load = useCallback(
    async (before: string | null) => {
      const ticket = gate.current.next()
      setLoading(true)
      const r = await dashJson<{ rows: LogRow[]; next: string | null }>(query(before))
      if (!gate.current.isLatest(ticket)) return // a newer filter or page was asked for meanwhile
      setLoading(false)
      if (!r.ok) return setError(r.error)
      setError(null)
      setRows((prev) => (before ? [...prev, ...r.data.rows] : r.data.rows))
      setNext(r.data.next)
    },
    [query],
  )
  useEffect(() => void load(null), [load])

  return (
    <Panel className="space-y-4">
      <div className="flex items-start gap-3">
        <IconChip icon={ScrollText} />
        <div>
          <Eyebrow>Request logs</Eyebrow>
          <p className="text-sm text-muted-foreground">Every call your keys made, newest first. Up to 31 days at a time; times are GMT.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
        <label className="col-span-2 flex flex-col gap-1 text-xs font-semibold text-muted-foreground sm:col-span-1">
          Key
          <select className={selectCls} value={key} onChange={(e) => setKey(e.target.value)}>
            <option value="">All keys</option>
            {keys.map((k) => <option key={k.id} value={k.id}>{keyLabel.get(k.id)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          Mode
          <select className={selectCls} value={env} onChange={(e) => setEnv(e.target.value)}>
            <option value="">Live and test</option>
            <option value="live">Live</option>
            <option value="test">Test</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          Result
          <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            <option value="ok">Succeeded</option>
            <option value="client">Refused (4xx)</option>
            <option value="server">Server error (5xx)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          From
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          To
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" />
        </label>
      </div>

      {error && <InlineError message={error} onRetry={() => void load(null)} />}
      {!loading && !error && rows.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No requests match these filters.</p>}

      {/* Phone: stacked cards. Desktop: table. */}
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className={cn("rounded-md px-2 py-0.5 text-xs font-bold tabular-nums", TONE_CHIP[httpTone(r.status)])}>{r.status}</span>
              <span className="text-xs text-muted-foreground">{shortTime(r.created_at)}</span>
            </div>
            <p className="mt-1 break-all font-mono text-xs">{r.method} {r.endpoint}</p>
            {r.reason && <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">{reasonLabel(r.reason)}</p>}
            <p className="mt-1 text-xs text-muted-foreground">{r.environment === "test" ? "Test" : "Live"}{r.duration_ms != null ? ` · ${r.duration_ms} ms` : ""}</p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">Time (GMT)</th>
              <th className="py-2 pr-3 font-semibold">Request</th>
              <th className="py-2 pr-3 font-semibold">Result</th>
              <th className="py-2 pr-3 font-semibold">Reason</th>
              <th className="py-2 pr-3 font-semibold">Key</th>
              <th className="py-2 text-right font-semibold">Time taken</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap py-2 pr-3 text-xs">{shortTime(r.created_at)}</td>
                <td className="max-w-[18rem] truncate py-2 pr-3 font-mono text-xs">{r.method} {r.endpoint}</td>
                <td className="py-2 pr-3">
                  <span className={cn("rounded-md px-2 py-0.5 text-xs font-bold tabular-nums", TONE_CHIP[httpTone(r.status)])}>{r.status}</span>
                </td>
                <td className="py-2 pr-3 text-xs">{reasonLabel(r.reason)}</td>
                <td className="whitespace-nowrap py-2 pr-3 text-xs text-muted-foreground">{(r.key_id && keyLabel.get(r.key_id)) || (r.environment === "test" ? "Test" : "Live")}</td>
                <td className="py-2 text-right text-xs tabular-nums">{r.duration_ms != null ? `${r.duration_ms} ms` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {next && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(next)}>{loading ? "Loading…" : "Load more"}</Button>
        </div>
      )}
    </Panel>
  )
}
