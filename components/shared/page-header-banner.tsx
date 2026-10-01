import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Note: the underlying CSS tokens (--admin-banner-from/-to) still carry an
// "admin" prefix from Phase 1, even though this component (like the sidebar)
// is no longer admin-only -- a rename ripples into globals.css and
// tailwind.config.ts too, left as tracked cosmetic debt rather than bundled
// into this page's rebuild.
export function PageHeaderBanner({
  title,
  subtitle,
  children,
  className,
}: {
  title: string
  subtitle: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-2xl bg-gradient-to-r from-admin-banner-from to-admin-banner-to p-6 sm:p-7', className)}>
      <h1 className="font-display text-xl font-bold text-white sm:text-2xl">{title}</h1>
      <p className="mt-1 text-sm text-white/80">{subtitle}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  )
}
