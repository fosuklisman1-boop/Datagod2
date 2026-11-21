"use client"

import { useEffect, useState } from "react"
import { Search, RotateCcw } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { FAILURE_REASON_LABELS, type FailureReason } from "@/lib/order-queue/failure-reason"
import { allSuppliers } from "@/lib/order-queue/supplier-capability"
import { rangeBoundToIso, isoToLocalParts } from "@/lib/order-queue/date-range"
import { ORDER_TYPES, type OrderType, type QueueParams } from "@/lib/order-queue/types"

export const STATUS_OPTIONS = ["pending", "processing", "completed", "failed", "reversed"] as const
export const NETWORK_OPTIONS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"] as const
export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  bulk: "Bulk",
  shop: "Shop",
  api: "API",
  ussd: "USSD",
  ussd_shop: "USSD Shop",
}
// "none" (no failure) is not a useful filter and its label is a dash.
const FAILURE_REASON_OPTIONS = (Object.keys(FAILURE_REASON_LABELS) as FailureReason[]).filter((r) => r !== "none")

const selectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"

export type FilterPanelProps = {
  params: QueueParams
  /** Called with the next params; the page puts them in the URL (offset already reset). */
  onChange: (next: QueueParams) => void
  onReset: () => void
}

function toggle<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

function CheckGroup<T extends string>({
  name,
  legend,
  options,
  selected,
  labelOf,
  onToggle,
}: {
  name: string
  legend: string
  options: readonly T[]
  selected: readonly T[]
  labelOf: (v: T) => string
  onToggle: (v: T) => void
}) {
  return (
    <fieldset className="space-y-2" data-filter={name}>
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{legend}</legend>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 lg:grid-cols-1">
        {options.map((o) => {
          const id = `f-${name}-${o.replace(/\W+/g, "-")}`
          return (
            <label key={o} htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox id={id} checked={selected.includes(o)} onCheckedChange={() => onToggle(o)} />
              {labelOf(o)}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

export function FilterPanel({ params, onChange, onReset }: FilterPanelProps) {
  const set = (patch: Partial<QueueParams>) => onChange({ ...params, ...patch, offset: 0 })

  const [search, setSearch] = useState(params.search)
  useEffect(() => setSearch(params.search), [params.search])
  const commitSearch = () => {
    const s = search.trim().slice(0, 100)
    if (s !== params.search) set({ search: s })
  }

  const from = isoToLocalParts(params.from, "from")
  const to = isoToLocalParts(params.to, "to")
  const setFrom = (date: string, time: string) => set({ from: rangeBoundToIso(date, time, "from") })
  const setTo = (date: string, time: string) => set({ to: rangeBoundToIso(date, time, "to") })

  return (
    <div className="space-y-5" data-filter-panel>
      <div className="space-y-1">
        <label htmlFor="f-search" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Search
        </label>
        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            id="f-search"
            placeholder="Reference, phone, email, store"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={commitSearch}
            onKeyDown={(e) => e.key === "Enter" && commitSearch()}
            className="pl-9"
          />
        </div>
      </div>

      <CheckGroup
        name="status"
        legend="Status"
        options={STATUS_OPTIONS}
        selected={params.statuses as (typeof STATUS_OPTIONS)[number][]}
        labelOf={(s) => s.charAt(0).toUpperCase() + s.slice(1)}
        onToggle={(s) => set({ statuses: toggle(params.statuses, s) })}
      />

      <CheckGroup
        name="network"
        legend="Network"
        options={NETWORK_OPTIONS}
        selected={params.networks as (typeof NETWORK_OPTIONS)[number][]}
        labelOf={(n) => n}
        onToggle={(n) => set({ networks: toggle(params.networks, n) })}
      />

      <CheckGroup
        name="type"
        legend="Order type"
        options={ORDER_TYPES}
        selected={params.types}
        labelOf={(t) => ORDER_TYPE_LABELS[t]}
        onToggle={(t) => set({ types: toggle(params.types, t) })}
      />

      <fieldset className="space-y-2" data-filter="dates">
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date range</legend>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Input type="date" aria-label="From date" value={from.date} onChange={(e) => setFrom(e.target.value, from.time)} />
          <Input
            type="time"
            aria-label="From time (optional)"
            value={from.time}
            disabled={!from.date}
            onChange={(e) => setFrom(from.date, e.target.value)}
            className="w-28"
          />
          <Input type="date" aria-label="To date" value={to.date} onChange={(e) => setTo(e.target.value, to.time)} />
          <Input
            type="time"
            aria-label="To time (optional)"
            value={to.time}
            disabled={!to.date}
            onChange={(e) => setTo(to.date, e.target.value)}
            className="w-28"
          />
        </div>
      </fieldset>

      <div className="space-y-1">
        <label htmlFor="f-last-supplier" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Last supplier
        </label>
        <select
          id="f-last-supplier"
          className={selectClass}
          value={params.lastProvider ?? ""}
          onChange={(e) => set({ lastProvider: e.target.value || null })}
        >
          <option value="">Any supplier</option>
          {allSuppliers().map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="f-failure-reason" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Failure reason
        </label>
        <select
          id="f-failure-reason"
          className={selectClass}
          value={params.failureReason ?? ""}
          onChange={(e) => set({ failureReason: (e.target.value || null) as FailureReason | null })}
        >
          <option value="">Any reason</option>
          {FAILURE_REASON_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {FAILURE_REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </div>

      <Button type="button" variant="outline" size="sm" className="w-full" onClick={onReset}>
        <RotateCcw className="mr-2 h-4 w-4" />
        Reset filters
      </Button>
    </div>
  )
}
