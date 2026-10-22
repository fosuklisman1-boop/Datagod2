"use client"

import { useMemo, useState } from "react"
import { KeyRound, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { filterKeys, roleLabel, roleOptions, statusCounts, type ConsoleKey, type KeyFilter } from "@/lib/api-v2/admin-view"
import type { KeyActivity } from "@/lib/api-v2/admin-stats"
import { KeyRow, type KeyRowHandlers } from "./KeyRow"
import { InlineError } from "./ui"

const STATUS_CHIPS: { value: KeyFilter["status"]; label: string; dot?: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending", dot: "bg-amber-500" },
  { value: "active", label: "Active", dot: "bg-emerald-500" },
  { value: "revoked", label: "Revoked", dot: "bg-rose-500" },
]

const SORT_LABELS: Record<KeyFilter["sort"], string> = { newest: "Newest", oldest: "Oldest", most_used: "Most used (24h)" }

export function KeyList({
  keys,
  busy,
  handlers,
  loading,
  sourceErrors,
  onRetry,
  previewOpen,
  previewActivity,
}: {
  keys: ConsoleKey[]
  busy: Record<string, boolean>
  handlers: KeyRowHandlers
  loading: boolean
  sourceErrors: string[]
  onRetry: () => void
  /** Preview-only: rows rendered with panels already expanded. */
  previewOpen?: Record<string, { activity?: boolean; limits?: boolean }>
  previewActivity?: Record<string, KeyActivity>
}) {
  const [filter, setFilter] = useState<KeyFilter>({ q: "", status: "all", role: "all", sort: "newest" })
  const counts = useMemo(() => statusCounts(keys), [keys])
  const roles = useMemo(() => roleOptions(keys), [keys])
  const shown = useMemo(() => filterKeys(keys, filter), [keys, filter])

  return (
    <div className="space-y-4">
      {sourceErrors.map((e) => (
        <InlineError key={e} message={e} onRetry={onRetry} />
      ))}

      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={filter.q}
            onChange={(e) => setFilter({ ...filter, q: e.target.value })}
            placeholder="Search by name, email, phone or key prefix..."
            aria-label="Search keys"
            className="h-11 rounded-xl bg-card pl-9"
          />
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
            {STATUS_CHIPS.map((c) => {
              const on = filter.status === c.value
              return (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter({ ...filter, status: c.value })}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"
                  )}
                >
                  {c.dot && <span className={cn("size-1.5 rounded-full", c.dot)} aria-hidden />}
                  {c.label}
                  <span className={cn("tabular-nums", on ? "text-primary-foreground/80" : "text-muted-foreground/80")}>{counts[c.value]}</span>
                </button>
              )
            })}
          </div>
          <div className="grid grid-cols-2 gap-2 lg:w-[360px]">
            <Select value={filter.role} onValueChange={(v) => setFilter({ ...filter, role: v })}>
              <SelectTrigger aria-label="Filter by role" className="h-10 w-full rounded-xl bg-card">
                <SelectValue>{filter.role === "all" ? "All Roles" : roleLabel(filter.role)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Roles</SelectItem>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {roleLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filter.sort} onValueChange={(v) => setFilter({ ...filter, sort: v as KeyFilter["sort"] })}>
              <SelectTrigger aria-label="Sort keys" className="h-10 w-full rounded-xl bg-card">
                <SelectValue>{SORT_LABELS[filter.sort]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SORT_LABELS) as KeyFilter["sort"][]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {SORT_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {loading && keys.length === 0 ? (
        <div className="grid gap-3 lg:grid-cols-2" aria-label="Loading keys">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-44 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-4 py-12 text-center">
          <KeyRound className="size-6 text-muted-foreground" aria-hidden />
          <p className="font-medium text-foreground">{keys.length === 0 ? "No API keys yet" : "No keys match these filters"}</p>
          <p className="text-sm text-muted-foreground">
            {keys.length === 0 ? "Keys appear here as soon as a developer generates one." : "Try another status, role or search."}
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Showing {shown.length} of {keys.length} keys
          </p>
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {shown.map((k) => (
              <KeyRow
                key={`${k.source}-${k.id}`}
                k={k}
                busy={!!busy[k.id]}
                handlers={handlers}
                initialOpen={previewOpen?.[k.id]}
                activityPreset={previewActivity?.[k.id]}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
