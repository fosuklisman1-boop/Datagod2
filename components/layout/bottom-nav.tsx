"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, Package, Wallet, ShoppingBag, Store, User, Users, CreditCard, Bot, Signal, Smartphone } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"
import { useUserRole } from "@/hooks/use-user-role"
import { cn } from "@/lib/utils"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { getServicePrimaryPath, type DomainService } from "@/lib/custom-domains"

// Short, FAB-appropriate labels for each service, used when a custom domain is
// scoped to one service and the FAB is repointed to that service's own page
// instead of the default Data/Buy Data target.
const SERVICE_FAB_LABELS: Record<DomainService, string> = {
  data_bundles: "Data",
  airtime: "Airtime",
  results_checker: "Results",
  bulk_sms: "SMS",
}

const ADMIN_NAV = [
  { href: "/admin/users",                label: "Users",    icon: Users,      isFab: false },
  { href: "/admin/order-payment-status", label: "Payments", icon: CreditCard, isFab: false },
  { href: "/admin/ai-settings",          label: "AI",       icon: Bot,        isFab: true  },
  { href: "/admin/packages",             label: "MTN",      icon: Signal,     isFab: false },
  { href: "/admin/ussd-shops",           label: "USSD",     icon: Smartphone, isFab: false },
]

export function BottomNav() {
  const pathname = usePathname()
  const isMobile = useIsMobile()
  const { isDealer, isAdmin, isSubAgent } = useUserRole()
  const domainBranding = useDomainBranding()

  if (!isMobile) return null

  // On a custom domain scoped to one or more services, the FAB — the single
  // most prominent control on mobile — is repointed to the first selected
  // service's own page instead of the hardcoded data-packages/buy-stock
  // target, so tapping it doesn't trigger middleware's service redirect to
  // somewhere else. Shop Dashboard is a dealer/business-management route
  // (blocked on any branded domain regardless of selected services — see
  // NON_SERVICE_GATED_PATHS in lib/custom-domains.ts), so it gets the same
  // treatment: repointed to Profile, an always-safe account-wide destination,
  // rather than a slot that would bounce the moment it's tapped. When
  // domainBranding.services is null (main site/shop, today's behavior for all
  // current traffic), both are no-ops: they fall through to the exact same
  // values as before.
  const primaryService = domainBranding.services?.[0] ?? null
  const fabHref = primaryService
    ? getServicePrimaryPath(primaryService)
    : isSubAgent ? "/dashboard/buy-stock" : "/dashboard/data-packages"
  const fabLabel = primaryService
    ? SERVICE_FAB_LABELS[primaryService]
    : isSubAgent ? "Buy Data" : "Data"
  const shopSlotHref = primaryService ? "/dashboard/profile" : "/dashboard/shop-dashboard"
  const shopSlotLabel = primaryService ? "Profile" : "Shop"
  const ShopSlotIcon = primaryService ? User : Store

  const USER_NAV = [
    { href: "/dashboard",             label: "Home",    icon: Home,        isFab: false },
    { href: "/dashboard/wallet",      label: "Wallet",  icon: Wallet,      isFab: false },
    { href: fabHref,                  label: fabLabel,  icon: Package,     isFab: true },
    { href: "/dashboard/my-orders",   label: "Orders",  icon: ShoppingBag, isFab: false },
    { href: shopSlotHref,             label: shopSlotLabel, icon: ShopSlotIcon, isFab: false },
  ]

  const onAdminPage = pathname.startsWith("/admin")
  const items = isAdmin && onAdminPage ? ADMIN_NAV : USER_NAV

  // Colour tokens — admin theme only applies when inside /admin pages.
  // Dealer uses the "Bold Telco" fuchsia/purple accent; everyone else the Fintech primary.
  const activeColor = isAdmin && onAdminPage
    ? "text-primary dark:text-primary"
    : isDealer
      ? "text-primary dark:text-primary"
      : "text-primary"

  const fabGradient = isAdmin && onAdminPage
    ? "bg-gradient-to-br from-primary to-brand-accent ring-4 ring-primary/15"
    : isDealer
      ? "bg-gradient-to-br from-primary to-brand-accent ring-4 ring-primary/15"
      : "bg-gradient-to-br from-primary to-brand-accent ring-4 ring-primary/15"

  const fabLabelColor = isAdmin && onAdminPage
    ? "text-primary"
    : isDealer ? "text-primary" : "text-primary"

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-card border-t border-border shadow-[0_-4px_20px_hsl(var(--foreground)/0.08)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex items-end justify-around h-16 px-1">
        {items.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/")

          if (item.isFab) {
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-end flex-1 pb-1"
              >
                <div className={cn(
                  "-mt-6 mb-0.5 w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform active:scale-95",
                  fabGradient
                )}>
                  <Icon className="w-7 h-7 text-primary-foreground" />
                </div>
                <span className={cn(
                  "text-[10px] font-medium",
                  isActive ? fabLabelColor : "text-muted-foreground"
                )}>
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
                isActive ? activeColor : "text-muted-foreground"
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
