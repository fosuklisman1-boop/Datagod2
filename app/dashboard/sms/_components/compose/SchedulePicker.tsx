"use client"

import { useId } from "react"
import { CalendarClock } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { formatScheduled, scheduleBounds, scheduleError, toLocalInputValue } from "../../_lib/view"

interface Props {
  enabled: boolean
  onEnabledChange: (on: boolean) => void
  /** datetime-local value, read as GMT. */
  value: string
  onValueChange: (v: string) => void
  /** ISO UTC of `value`, or null when empty/invalid. */
  iso: string | null
  disabled?: boolean
}

export function SchedulePicker({ enabled, onEnabledChange, value, onValueChange, iso, disabled }: Props) {
  const id = useId()
  const now = new Date()
  const { min, max } = scheduleBounds(now)
  const error = enabled && value ? scheduleError(iso, now) : null

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${id}-sw`} className="flex items-center gap-2 text-sm font-medium">
          <CalendarClock className="h-4 w-4 text-primary" /> Send later
        </Label>
        <Switch
          id={`${id}-sw`} checked={enabled} disabled={disabled}
          onCheckedChange={(on) => {
            onEnabledChange(on)
            if (on && !value) onValueChange(toLocalInputValue(new Date(min.getTime() + 60 * 60_000)))
          }}
          aria-label="Send later"
        />
      </div>
      {enabled && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-dt`} className="text-xs text-muted-foreground">Date and time (GMT)</Label>
          <Input
            id={`${id}-dt`} type="datetime-local" className="w-full lg:max-w-xs"
            value={value} min={toLocalInputValue(min)} max={toLocalInputValue(max)}
            onChange={(e) => onValueChange(e.target.value)}
            aria-invalid={!!error} aria-describedby={`${id}-help`}
          />
          <p id={`${id}-help`} className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"}`} role={error ? "alert" : undefined}>
            {error ?? (iso ? `Will be sent on ${formatScheduled(iso)}. Credits are reserved now; you can cancel from Records until then.` : "Choose when to send (2 minutes to 30 days from now).")}
          </p>
        </div>
      )}
    </div>
  )
}
