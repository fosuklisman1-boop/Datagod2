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

// Same visual language as the shop storefront's brand hero (diagonal
// gradient + two soft glow-blur circles), reused here for the customer
// dashboard's page headers instead of a plain <h1>. Dealer keeps its own
// flat amber identity (bg-warning, no gradient) matching every other hero
// card in the dashboard (e.g. the wallet balance card) rather than the
// per-shop custom_color the storefront version uses.
export function DashboardHeroBanner({ title, subtitle, icon: Icon, backHref, children }: Props) {
  const { isDealer } = useUserRole()

  return (
    <div
      className={`relative overflow-hidden rounded-2xl px-5 py-6 text-white shadow-sm sm:px-7 sm:py-7 ${isDealer ? "bg-warning" : "bg-gradient-to-br from-[#1b388b] to-[#2a5ce8]"}`}
    >
      <span className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
      <span className="pointer-events-none absolute -bottom-10 left-16 h-28 w-28 rounded-full bg-white/5 blur-xl" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {backHref && (
            <Link href={backHref} className="mt-1 shrink-0 text-white/80 hover:text-white">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          )}
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
              {Icon && <Icon className="h-5 w-5 shrink-0" />} {title}
            </h1>
            {subtitle && <p className={`mt-1 text-sm ${isDealer ? "text-amber-100" : "text-white/80"}`}>{subtitle}</p>}
          </div>
        </div>
        {children && <div className="shrink-0">{children}</div>}
      </div>
    </div>
  )
}
