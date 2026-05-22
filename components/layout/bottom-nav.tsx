"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, Package, Wallet, User, Sparkles } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"
import { useUserRole } from "@/hooks/use-user-role"
import { cn } from "@/lib/utils"

const NAV_ITEMS = [
  { href: "/dashboard",               label: "Home",    icon: Home,     isFab: false },
  { href: "/dashboard/wallet",        label: "Wallet",  icon: Wallet,   isFab: false },
  { href: "/dashboard/data-packages", label: "Data",    icon: Package,  isFab: true  },
  { href: "/dashboard/profile",       label: "Profile", icon: User,     isFab: false },
  { href: "/dashboard/upgrade",       label: "Upgrade", icon: Sparkles, isFab: false },
]

export function BottomNav() {
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const { isDealer } = useUserRole()

  if (!isMobile) return null

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 shadow-[0_-4px_20px_rgba(0,0,0,0.08)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex items-end justify-around h-16 px-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href

          if (item.isFab) {
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-end flex-1 pb-1"
              >
                <div
                  className={cn(
                    "-mt-6 mb-0.5 w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform active:scale-95",
                    isDealer
                      ? "bg-gradient-to-br from-amber-400 to-amber-600 ring-4 ring-amber-100 dark:ring-amber-900"
                      : "bg-gradient-to-br from-blue-500 to-blue-700 ring-4 ring-blue-100 dark:ring-blue-900"
                  )}
                >
                  <Icon className="w-7 h-7 text-white" />
                </div>
                <span
                  className={cn(
                    "text-[10px] font-medium",
                    isActive
                      ? isDealer ? "text-amber-500" : "text-blue-600"
                      : "text-gray-400 dark:text-gray-500"
                  )}
                >
                  {item.label}
                </span>
              </Link>
            )
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center flex-1 py-2 gap-0.5 transition-colors",
                isActive
                  ? isDealer
                    ? "text-amber-500 dark:text-amber-400"
                    : "text-blue-600 dark:text-blue-400"
                  : "text-gray-500 dark:text-gray-400"
              )}
            >
              <Icon className={cn("w-5 h-5", isActive && "stroke-[2.5]")} />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
