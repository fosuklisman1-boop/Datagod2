"use client"

import { useEffect, useState } from "react"
import { Loader2, Trash2 } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { parseV1RateLimit, type ConsoleKey } from "@/lib/api-v2/admin-view"
import { ConfirmAction } from "./ConfirmAction"

/** The controls the legacy v1 admin routes support: enable/disable, one req/min limit, delete. */
export function V1Controls({
  k,
  busy,
  onToggle,
  onDelete,
  onSetRate,
}: {
  k: ConsoleKey
  busy: boolean
  onToggle: () => Promise<boolean>
  onDelete: () => Promise<boolean>
  onSetRate: (perMin: number) => Promise<boolean>
}) {
  const current = k.v1RatePerMin === null ? "" : String(k.v1RatePerMin)
  const [rate, setRate] = useState(current)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setRate(current)
    setError(null)
  }, [current])

  const saveRate = async () => {
    const r = parseV1RateLimit(rate)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setError(null)
    await onSetRate(r.value)
  }

  const id = `v1-rate-${k.id}`
  const active = k.status === "active"

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground">
          <Switch checked={active} disabled={busy} onCheckedChange={() => void onToggle()} aria-label={active ? "Disable key" : "Enable key"} />
          {active ? "Enabled" : "Disabled"}
        </label>
        <div className="flex items-center gap-1.5">
          <label htmlFor={id} className="sr-only">
            Requests per minute
          </label>
          <Input
            id={id}
            inputMode="numeric"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            aria-invalid={!!error}
            className={cn("h-9 w-20 rounded-lg bg-background font-mono tabular-nums", error && "border-destructive")}
          />
          <span className="text-xs text-muted-foreground">req/min</span>
          <button
            type="button"
            onClick={saveRate}
            disabled={busy || rate.trim() === current}
            className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : "Save"}
          </button>
        </div>
        <ConfirmAction
          trigger={
            <button
              type="button"
              disabled={busy}
              aria-label="Delete key"
              className="ml-auto inline-flex size-9 items-center justify-center rounded-lg border border-rose-500/40 text-rose-600 hover:bg-rose-500/10 disabled:opacity-60 dark:text-rose-400"
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          }
          title="Delete this v1 API key?"
          description={
            <p>
              <span className="font-mono">{k.prefix}…</span> owned by {k.ownerName} is permanently deleted. This cannot be undone.
            </p>
          }
          confirmLabel="Delete permanently"
          onConfirm={onDelete}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
