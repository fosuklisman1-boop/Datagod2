"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, Package, Wallet, ShoppingBag, Store, User, Users, CreditCard, Bot, Signal, Smartphone } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"
import { useUserRole } from "@/hooks/use-user-role"
import { cn } from "@/lib/utils"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { getServicePrimaryPath, isPageHidden, type DomainService } from "@/lib/custom-domains"
import { bottomNavSkinClasses, type BottomNavSkin } from "@/lib/bottom-nav-theme"

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
    ...(isPageHidden("wallet", domainBranding.hiddenPages)
      ? []
      : [{ href: "/dashboard/wallet", label: "Wallet", icon: Wallet, isFab: false }]),
    { href: fabHref,                  label: fabLabel,  icon: Package,     isFab: true },
    { href: "/dashboard/my-orders",   label: "Orders",  icon: ShoppingBag, isFab: false },
    { href: shopSlotHref,             label: shopSlotLabel, icon: ShopSlotIcon, isFab: false },
  ]

  const onAdminPage = pathname.startsWith("/admin")
  const items = isAdmin && onAdminPage ? ADMIN_NAV : USER_NAV

  // Same 3-way identity used everywhere else in the rebuild: admin's own
  // dark panel skin while browsing /admin pages, dealer's amber "Bold Telco"
  // accent (matching e.g. the Wallet balance hero's isDealer ? bg-warning),
  // navy for everyone else.
  const skin: BottomNavSkin = isAdmin && onAdminPage ? "admin" : isDealer ? "dealer" : "default"
  const c = bottomNavSkinClasses(skin)

  return (
    <nav
      className={cn(
        "fixed left-3 right-3 z-50 md:hidden rounded-[28px] shadow-[0_10px_30px_-6px_hsl(var(--foreground)/0.25)]",
        c.bar
      )}
      style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <div className="flex items-end justify-around h-[68px] px-1">
        {items.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/")

          if (item.isFab) {
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-end flex-1 pb-2"
              >
                <div className={cn(
                  "-mt-8 w-16 h-16 rounded-full flex flex-col items-center justify-center gap-0.5 shadow-lg transition-transform active:scale-95",
                  c.fabCircle
                )}>
                  <Icon className={cn("w-5 h-5", c.fabIconText)} />
                  <span className={cn("text-[9px] font-bold leading-none", isActive ? c.fabLabelActive : c.fabLabelInactive)}>
                    {item.label}
                  </span>
                </div>
              </Link>
            )
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center flex-1 py-2.5 gap-0.5 transition-colors",
                isActive ? c.navLinkActive : c.navLinkInactive
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
