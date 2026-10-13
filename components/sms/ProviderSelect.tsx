"use client"

import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type SmsProviderValue = "" | "moolre" | "hubtel"

// Radix Select forbids "" as an item value, so the "no override" option uses a sentinel.
const DEFAULT_SENTINEL = "default"

interface ProviderSelectProps {
  value: SmsProviderValue
  onChange: (value: SmsProviderValue) => void
  defaultLabel?: string
  disabled?: boolean
  id?: string
  label?: string
}

export function ProviderSelect({
  value,
  onChange,
  defaultLabel = "System default",
  disabled,
  id,
  label,
}: ProviderSelectProps) {
  return (
    <div className="space-y-1.5">
      {label && <Label htmlFor={id}>{label}</Label>}
      <Select
        value={value === "" ? DEFAULT_SENTINEL : value}
        onValueChange={(v) => onChange(v === DEFAULT_SENTINEL ? "" : (v as SmsProviderValue))}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL}>{defaultLabel}</SelectItem>
          <SelectItem value="moolre">Moolre</SelectItem>
          <SelectItem value="hubtel">Hubtel</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
