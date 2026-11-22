"use client"

import { ChevronDown, FileSpreadsheet, Loader2, Send, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatGb } from "@/lib/order-queue/confirm-summary"
import type { SupplierOption } from "@/lib/order-queue/supplier-capability"

/** Statuses the bar can set, the same set as the per-row "Update Status" menu. */
export const BAR_STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
] as const

export type BulkActionBarProps = {
  selectedCount: number
  /** null while the "all matching" rows are still loading. */
  totalGb: number | null
  /** Suppliers that can serve every network in the selection (suppliersForNetworks). */
  suppliers: SupplierOption[]
  /** supplier value -> display balance ("GHS 1,234.50"); missing = show nothing. */
  balances: Record<string, string>
  busy: boolean
  exporting: boolean
  onSend: (supplier: SupplierOption) => void
  onChangeStatus: (status: string) => void
  onExport: () => void
  onClear: () => void
}

/** Sticky bar at the bottom of the viewport while at least one row is selected. Presentational; the page owns state. */
export function BulkActionBar({
  selectedCount,
  totalGb,
  suppliers,
  balances,
  busy,
  exporting,
  onSend,
  onChangeStatus,
  onExport,
  onClear,
}: BulkActionBarProps) {
  if (selectedCount === 0) return null
  return (
    <div data-testid="bulk-action-bar" className="sticky bottom-0 z-40 min-w-0 pb-3 pt-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-background/95 px-3 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <span data-testid="bar-summary" className="mr-auto min-w-0 text-sm font-semibold text-primary">
          {selectedCount} selected · {totalGb === null ? "…" : formatGb(totalGb)} GB
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="gap-1" disabled={busy || suppliers.length === 0}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send to supplier
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Pick one supplier (hard pin)</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {suppliers.map((s) => (
              <DropdownMenuItem key={s.value} className="cursor-pointer justify-between gap-3" onSelect={() => onSend(s)}>
                <span>{s.label}</span>
                {balances[s.value] && (
                  <span data-balance={s.value} className="text-xs tabular-nums text-muted-foreground">
                    {balances[s.value]}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1" disabled={busy}>
              Change status
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {BAR_STATUSES.map((s) => (
              <DropdownMenuItem key={s.value} className="cursor-pointer" onSelect={() => onChangeStatus(s.value)}>
                {s.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button size="sm" variant="outline" className="gap-1" onClick={onExport} disabled={exporting}>
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
          Export
        </Button>
        <Button size="sm" variant="ghost" className="px-2" onClick={onClear} aria-label="Clear selection">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
