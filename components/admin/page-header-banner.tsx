import type { ReactNode } from 'react'

export function AdminPageHeaderBanner({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children?: ReactNode
}) {
  return (
    <div className="rounded-2xl bg-gradient-to-r from-admin-banner-from to-admin-banner-to p-6 sm:p-7">
      <h1 className="font-display text-xl font-bold text-white sm:text-2xl">{title}</h1>
      <p className="mt-1 text-sm text-white/80">{subtitle}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  )
}
