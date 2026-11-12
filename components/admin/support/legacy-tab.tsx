"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, RefreshCw, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { SupplierResult } from "@/lib/order-supplier"
import {
  filterLegacy,
  legacyStatusCounts,
  userDisplayName,
  type DatePreset,
  type LegacyListItem,
} from "@/lib/support-admin-client"
import { cn } from "@/lib/utils"
import { adminApi } from "./support-api"
import { LegacyDetailDialog, LegacyStatusBadge } from "./legacy-detail-dialog"
import { formatDateTime } from "./order-details-dialog"
import { SupplierBadge } from "./supplier-badge"

export interface LegacyComplaint extends LegacyListItem {
  has_evidence: boolean
  evidence_paths: { balance_image_path: string | null; momo_receipt_path: string | null }
  resolution_notes: string | null
  supplier: SupplierResult
}

const selectCls = "h-10 rounded-md border border-input bg-background px-3 text-sm"
const STATUSES = ["all", "pending", "in_review", "resolved", "rejected"] as const
const PRESETS: { value: DatePreset; label: string }[] = [
  { value: "all", label: "Any date" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "custom", label: "Custom range" },
]

function UserCell({ c }: { c: LegacyComplaint }) {
  return (
    <>
      <p className="truncate text-sm font-medium">{userDisplayName(c.user)}</p>
      {c.order?.shop_name && (
        <Badge variant="outline" className="mt-0.5 max-w-full truncate">
          Shop: {c.order.shop_name}
        </Badge>
      )}
    </>
  )
}

export function LegacyTab() {
  const [items, setItems] = useState<LegacyComplaint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState("30")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("all")
  const [preset, setPreset] = useState<DatePreset>("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const r = await adminApi<{ complaints: LegacyComplaint[] }>(`/api/admin/complaints?days=${days}`)
      if (r.ok && r.data) {
        setItems(r.data.complaints)
        setError(null)
      } else {
        setError(r.error ?? "Could not load complaints")
      }
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    void load()
  }, [load])

  const counts = useMemo(() => legacyStatusCounts(items), [items])
  const visible = useMemo(() => filterLegacy(items, { search, status, preset, from, to }), [items, search, status, preset, from, to])
  const selected = items.find((c) => c.id === selectedId) ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, issue or order reference" className="pl-9" />
        </div>
        <select aria-label="Status" className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All" : s.replace("_", " ")} ({counts[s]})
            </option>
          ))}
        </select>
        <select aria-label="Date" className={selectCls} value={preset} onChange={(e) => setPreset(e.target.value as DatePreset)}>
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select aria-label="Window" className={selectCls} value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="7">Loaded: 7 days</option>
          <option value="30">Loaded: 30 days</option>
          <option value="90">Loaded: 90 days</option>
        </select>
        <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {preset === "custom" && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading && items.length === 0 ? (
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
                    <TableHead>User</TableHead>
                    <TableHead>Order Ref</TableHead>
                    <TableHead>Order Date</TableHead>
                    <TableHead>Beneficiary</TableHead>
                    <TableHead>Package</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Issue</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Filed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((c) => (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => setSelectedId(c.id)}>
                      <TableCell className="max-w-[180px]">
                        <UserCell c={c} />
                      </TableCell>
                      <TableCell className="text-sm">{c.order?.reference ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{formatDateTime(c.order?.created_at)}</TableCell>
                      <TableCell className="text-sm">{c.order?.beneficiary ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{[c.order?.network, c.order?.size].filter(Boolean).join(" ") || "—"}</TableCell>
                      <TableCell>
                        <SupplierBadge supplier={c.supplier} />
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate text-sm">{c.title}</TableCell>
                      <TableCell>
                        <LegacyStatusBadge status={c.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{formatDateTime(c.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>

          <div className="space-y-2 lg:hidden">
            {visible.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className="w-full rounded-xl border border-border bg-card p-3 text-left transition hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <UserCell c={c} />
                  </div>
                  <LegacyStatusBadge status={c.status} />
                </div>
                <p className="mt-1 break-words text-sm">{c.title}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>{c.order?.reference ?? "No order"}</span>
                  {c.order?.beneficiary && <span>{c.order.beneficiary}</span>}
                  <span>{[c.order?.network, c.order?.size].filter(Boolean).join(" ")}</span>
                  <SupplierBadge supplier={c.supplier} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Filed {formatDateTime(c.created_at)}</p>
              </button>
            ))}
          </div>
        </>
      )}

      <LegacyDetailDialog complaint={selected} onClose={() => setSelectedId(null)} onChanged={() => void load()} />
    </div>
  )
}
