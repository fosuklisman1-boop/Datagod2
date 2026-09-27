import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { statusPillClasses, type StatusPillVariant } from '@/lib/admin-theme'

export function StatusPill({
  variant,
  children,
  className,
}: {
  variant: StatusPillVariant
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold',
        statusPillClasses(variant),
        className
      )}
    >
      {children}
    </span>
  )
}
