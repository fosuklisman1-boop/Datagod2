'use client'

import { cn } from '@/lib/utils'
import { segmentedPillItemClasses } from '@/lib/admin-theme'

export interface SegmentedPillOption {
  label: string
  value: string
}

export function SegmentedPillToggle({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentedPillOption[]
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <div className={cn('inline-flex rounded-full bg-white/10 p-1', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-full px-4 py-1.5 text-sm transition-colors',
            segmentedPillItemClasses(option.value === value)
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
