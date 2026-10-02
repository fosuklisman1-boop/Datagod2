"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft, type LucideIcon } from "lucide-react"
import { useUserRole } from "@/hooks/use-user-role"

interface Props {
  title: ReactNode
  subtitle?: ReactNode
  icon?: LucideIcon
  backHref?: string
  children?: ReactNode
}

// Exact visual match for the shop storefront's brand hero (app/shop/[slug]/
// page.tsx): same rounded-b-2xl silhouette, px-6 py-10 padding, centered
// text, and the same two glow-blur circles at the same positions. Dealer
// keeps its own flat amber identity (bg-warning, no gradient) matching
// every other hero card in the dashboard (e.g. the wallet balance card)
// rather than the per-shop custom_color the storefront version uses.
//
// Unlike the storefront hero, dashboard pages often need a back-arrow
// and/or header actions -- both float directly on the banner (top-left
// and top-right corners respectively) instead of breaking the centered
// title or pushing the banner's height out with an extra row.
export function DashboardHeroBanner({ title, subtitle, icon: Icon, backHref, children }: Props) {
  const { isDealer } = useUserRole()

  return (
    <div
      className={`relative overflow-hidden rounded-b-2xl px-6 py-10 text-center text-white shadow-sm ${isDealer ? "bg-warning" : "bg-gradient-to-br from-[#1b388b] to-[#2a5ce8]"}`}
    >
      <span className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
      <span className="pointer-events-none absolute -bottom-10 left-16 h-28 w-28 rounded-full bg-white/5 blur-xl" />
      {backHref && (
        <Link href={backHref} className="absolute left-4 top-4 text-white/80 hover:text-white">
          <ArrowLeft className="h-5 w-5" />
        </Link>
      )}
      {children && <div className="absolute right-4 top-4 flex flex-wrap items-center justify-end gap-2">{children}</div>}
      <h1 className="relative flex items-center justify-center gap-2 text-2xl font-bold text-white sm:text-3xl">
        {Icon && <Icon className="h-6 w-6 shrink-0" />} {title}
      </h1>
      {subtitle && (
        <p className={`relative mx-auto mt-2 max-w-2xl break-words text-sm sm:text-base ${isDealer ? "text-amber-100" : "text-white/90"}`}>
          {subtitle}
        </p>
      )}
    </div>
  )
}
