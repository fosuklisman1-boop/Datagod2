"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Search, Users } from "lucide-react"
import type { DeveloperRow } from "@/lib/api-v2/admin-console/developers"
import { ghs, parseDevParam, pct, SEARCH_DEBOUNCE_MS } from "@/lib/api-v2/admin-console/developers-view"
import { cn } from "@/lib/utils"
import { adminFetch } from "./admin-fetch"
import { Badges, DeveloperProfilePanel } from "./DeveloperProfile"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"

export function DevelopersListView(p: {
  items: DeveloperRow[]
  total: number
  page: number
  pageSize: number
  q: string
  loading: boolean
  error: string | null
  selected: string | null
  onQuery: (q: string) => void
  onPage: (page: number) => void
  onSelect: (userId: string) => void
  onRetry: () => void
}) {
  const from = p.total === 0 ? 0 : p.page * p.pageSize + 1
  const to = Math.min(p.total, (p.page + 1) * p.pageSize)
  return (
    <Panel className="space-y-4">
      <div className="flex items-start gap-3">
        <IconChip icon={Users} />
        <div className="min-w-0 flex-1">
          <Eyebrow>API v2</Eyebrow>
          <h2 className="text-base font-bold text-foreground">Developers</h2>
          <p className="text-sm text-muted-foreground">Everyone with v2 keys. Numbers cover the last 30 days.</p>
        </div>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={p.q}
          onChange={(e) => p.onQuery(e.target.value)}
          maxLength={60}
          placeholder="Search by name or email..."
          aria-label="Search developers"
          className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm"
        />
      </div>
      {p.error ? (
        <InlineError message={p.error} onRetry={p.onRetry} />
      ) : p.loading && p.items.length === 0 ? (
        <div className="h-32 animate-pulse rounded-xl bg-muted" aria-label="Loading developers" />
      ) : p.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">No developers match.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {p.items.map((d) => (
            <li key={d.userId}>
              <button
                type="button"
                onClick={() => p.onSelect(d.userId)}
                aria-current={p.selected === d.userId ? "true" : undefined}
                className={cn("w-full space-y-1 px-3 py-2.5 text-left transition-colors hover:bg-muted/60", p.selected === d.userId && "bg-primary/[0.06]")}
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="break-words font-semibold text-foreground">{d.name ?? "Unnamed developer"}</span>
                  <Badges paused={d.paused} granted={d.granted} />
                </span>
                <span className="block break-all text-xs text-muted-foreground">{d.email ?? "No email"} · {d.role ?? "no role"}</span>
                <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>{d.keysActive} active{d.keysPending > 0 ? `, ${d.keysPending} waiting` : ""}</span>
                  <span>{d.requests.toLocaleString("en-GH")} calls</span>
                  <span>{pct(d.successRate)}</span>
                  <span>{ghs(d.spent)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{p.total === 0 ? "0" : `${from}-${to} of ${p.total}`}</span>
        <span className="flex gap-2">
          <button type="button" disabled={p.page === 0 || p.loading} onClick={() => p.onPage(p.page - 1)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2.5 disabled:opacity-50">
            <ChevronLeft className="size-4" aria-hidden />
            Previous
          </button>
          <button type="button" disabled={to >= p.total || p.loading} onClick={() => p.onPage(p.page + 1)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2.5 disabled:opacity-50">
            Next
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </span>
      </div>
    </Panel>
  )
}

function readDevParam(): string | null {
  if (typeof window === "undefined") return null
  return parseDevParam(new URLSearchParams(window.location.search).get("dev"))
}

/** Developers tab: list on the left, profile on the right (phone: list, then the profile full width with Back). */
export function DevelopersTab() {
  const [q, setQ] = useState("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const [data, setData] = useState<{ items: DeveloperRow[]; total: number; pageSize: number }>({ items: [], total: 0, pageSize: 25 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    setSelected(readDevParam())
    const onPop = () => setSelected(readDevParam())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim())
      setPage(0)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q])

  const load = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ page: String(page) })
    if (query) params.set("q", query)
    const r = await adminFetch<{ items?: DeveloperRow[]; total?: number; pageSize?: number }>(`/api/admin/api-v2/developers?${params}`)
    if (mine !== seq.current) return // a newer search already answered
    setData(r.ok ? { items: r.data?.items ?? [], total: r.data?.total ?? 0, pageSize: r.data?.pageSize ?? 25 } : { items: [], total: 0, pageSize: 25 })
    setError(r.ok ? null : r.error)
    setLoading(false)
  }, [page, query])

  useEffect(() => {
    void load()
  }, [load])

  const select = (userId: string | null) => {
    setSelected(userId)
    const url = new URL(window.location.href)
    url.searchParams.set("tab", "developers")
    if (userId) url.searchParams.set("dev", userId)
    else url.searchParams.delete("dev")
    window.history.pushState(null, "", url)
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className={cn(selected && "hidden lg:block")}>
        <DevelopersListView
          items={data.items}
          total={data.total}
          page={page}
          pageSize={data.pageSize}
          q={q}
          loading={loading}
          error={error}
          selected={selected}
          onQuery={setQ}
          onPage={setPage}
          onSelect={select}
          onRetry={() => void load()}
        />
      </div>
      {selected ? (
        <DeveloperProfilePanel userId={selected} onBack={() => select(null)} onChanged={() => void load()} />
      ) : (
        <Panel className="hidden items-center justify-center text-sm text-muted-foreground lg:flex">Choose a developer to see their profile.</Panel>
      )}
    </div>
  )
}
