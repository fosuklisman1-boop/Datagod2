"use client"

import { useEffect, useState } from "react"
import { Loader2, RotateCcw, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { DEFAULT_LIMITS, type LimitGroup } from "@/lib/api-v2/limits"
import { limitFormValues, validateLimitForm, type ConsoleKey } from "@/lib/api-v2/admin-view"

const GROUPS = Object.keys(DEFAULT_LIMITS) as LimitGroup[]

const toStrings = (k: ConsoleKey) => {
  const v = limitFormValues(k.rateLimits)
  return Object.fromEntries(GROUPS.map((g) => [g, String(v[g])])) as Record<LimitGroup, string>
}

export function LimitsEditor({
  k,
  busy,
  onSave,
  onReset,
}: {
  k: ConsoleKey
  busy: boolean
  onSave: (limits: Record<LimitGroup, number>) => Promise<boolean>
  onReset: () => Promise<boolean>
}) {
  const [values, setValues] = useState(() => toStrings(k))
  const [errors, setErrors] = useState<Partial<Record<LimitGroup, string>>>({})

  // Re-sync when the key's stored limits change (after save, reset or a refresh).
  const stored = JSON.stringify(k.rateLimits)
  useEffect(() => {
    setValues(toStrings(k))
    setErrors({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored])

  const save = async () => {
    const r = validateLimitForm(values)
    if (!r.ok) {
      setErrors(r.errors)
      return
    }
    setErrors({})
    await onSave(r.value)
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/50 p-3 dark:bg-white/[0.02]">
      <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-foreground">
        <SlidersHorizontal className="size-4 text-primary" aria-hidden />
        Per-Key Rate Limits
        <span className="font-normal text-muted-foreground">(req / min)</span>
        {k.rateLimits === null && <span className="text-xs font-normal text-muted-foreground">· using defaults</span>}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {GROUPS.map((g) => {
          const id = `limit-${k.id}-${g}`
          return (
            <div key={g} className="min-w-0 space-y-1">
              <label htmlFor={id} className="block text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                {g}
              </label>
              <Input
                id={id}
                inputMode="numeric"
                value={values[g]}
                onChange={(e) => setValues({ ...values, [g]: e.target.value })}
                aria-invalid={!!errors[g]}
                aria-describedby={errors[g] ? `${id}-err` : undefined}
                className={cn("h-10 rounded-lg bg-background font-mono tabular-nums", errors[g] && "border-destructive")}
              />
              {errors[g] ? (
                <p id={`${id}-err`} className="text-[11px] leading-4 text-destructive">
                  {errors[g]}
                </p>
              ) : (
                <p className="text-[11px] leading-4 text-muted-foreground">Default {DEFAULT_LIMITS[g]}</p>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy} className="h-9 rounded-lg px-4 font-semibold">
          {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          Save Limits
        </Button>
        <Button variant="outline" onClick={() => void onReset()} disabled={busy || k.rateLimits === null} className="h-9 rounded-lg border-border">
          <RotateCcw className="mr-2 size-3.5" aria-hidden />
          Reset to Default
        </Button>
      </div>
    </div>
  )
}
