import {
  Layers, Package, ShoppingCart, IdCard, Wallet, History, User, AlertCircle,
  Store, Settings, Users, ShoppingBag, Zap, Sparkles, Smartphone, Activity,
  GraduationCap, Send, Code2, Tag, Banknote,
  type LucideIcon,
} from "lucide-react"
import { isPathAllowedForService, type DomainService } from "./custom-domains"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  roles: string[]
}

export const menuItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: Layers, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/data-packages", label: "Data Packages", icon: Package, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/airtime", label: "Buy Airtime", icon: Smartphone, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/results-checker", label: "Results Checker", icon: GraduationCap, roles: ["user", "admin", "dealer", "sub_agent"] },
  { href: "/dashboard/results-check", label: "Check Results", icon: GraduationCap, roles: ["user", "admin", "dealer", "sub_agent"] },
  { href: "/dashboard/my-orders", label: "My Orders", icon: ShoppingCart, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/afa-orders", label: "AFA Orders", icon: IdCard, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/transactions", label: "Transactions", icon: History, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/profile", label: "Profile", icon: User, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/developer", label: "Developer / API", icon: Code2, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/complaints", label: "My Complaints", icon: AlertCircle, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/upgrade", label: "Upgrade to Dealer", icon: Sparkles, roles: ["user", "admin", "dealer"] },
]

export const shopItems: NavItem[] = [
  { href: "/dashboard/my-shop", label: "Overview", icon: Store, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-orders", label: "Orders", icon: ShoppingCart, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/customers", label: "Customers", icon: Users, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-profit-logs", label: "Profit Logs", icon: Activity, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-pricing", label: "Pricing", icon: Tag, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/sms", label: "SMS", icon: Send, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-withdraw", label: "Withdraw", icon: Banknote, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-profile", label: "Shop Profile", icon: Settings, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/ussd-shop", label: "USSD/WhatsApp Bot", icon: Smartphone, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/payment-reverify", label: "Payment Reverify", icon: Zap, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/sub-agents", label: "Sub-Agents", icon: Users, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/sub-agent-catalog", label: "Sub-Agent Catalog", icon: Package, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/buy-stock", label: "Buy Data", icon: ShoppingBag, roles: ["sub_agent"] },
]

/**
 * Walks menuItems then shopItems in order and returns the first href that
 * passes every filter sidebar.tsx itself already applies when rendering:
 * role membership, the one dealer-subscription special case (Upgrade is
 * hidden from a dealer with no active subscription), and the domain's
 * services/hidden_pages gating. Returns null if nothing qualifies (e.g.
 * every page for this role has been hidden) — callers fall back to
 * /dashboard/unavailable in that case.
 */
export function pickFirstVisiblePath(
  role: string | null,
  services: DomainService[] | null,
  hiddenPages: string[],
  dealerHasSubscription: boolean
): string | null {
  if (!role) return null
  const allItems = [...menuItems, ...shopItems]
  for (const item of allItems) {
    if (!item.roles.includes(role)) continue
    if (item.href === "/dashboard/upgrade" && role === "dealer" && !dealerHasSubscription) continue
    if (!isPathAllowedForService(item.href, services, hiddenPages)) continue
    return item.href
  }
  return null
}
