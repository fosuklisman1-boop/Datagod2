import {
  Layers, Package, ShoppingCart, IdCard, Wallet, History, User, AlertCircle,
  Store, Settings, Users, ShoppingBag, Zap, Sparkles, Smartphone, Activity,
  GraduationCap, Send, ShieldAlert, Code2, Tag, Banknote, Lightbulb, Wifi, Trophy, MessageSquareText,
  Lock, Download, ArrowRightLeft, RotateCcw, CreditCard, BadgeCheck, Crown,
  Signal, ClipboardCheck, Percent, Phone, PhoneOff, SmartphoneNfc, MessageCircle,
  Hash, MessageSquare, BookOpen, Shield, Gauge, Clock, Globe, HandCoins, Ban, Receipt,
  type LucideIcon,
} from "lucide-react"
import { isPathAllowedForService, isPageHidden, type DomainService } from "./custom-domains"
import type { NavGroupDef } from "./nav-groups"
import { navVisible, type Capability, type RoleRights } from "./roles/capabilities"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** Capability a role must hold to see this item. Omitted = every non-sub_agent role sees it. */
  cap?: Capability
  /** Also shown to sub_agent (their fixed set; sub_agent never uses capabilities). */
  subAgent?: boolean
  /** Shown to sub_agent only, whatever capabilities or admin rights anyone holds. */
  subAgentOnly?: boolean
  /** Hidden unless /api/bills/availability reports this feature enabled (filtered where the sidebar renders). */
  feature?: "bills" | "broadband" | "standard-bundles"
  /** Never picked as a landing page by pickFirstVisiblePath. */
  notLanding?: boolean
  /** Sidebar heading this item sits under (a `menuGroups` id). Omitted = above the first heading. */
  group?: string
}

/** Headings for `menuItems`, in display order. Items keep their array order inside a group. */
export const menuGroups: readonly NavGroupDef[] = [
  { id: "buy", label: "Buy" },
  { id: "orders", label: "Orders & Money" },
  { id: "account", label: "Account" },
]

/** Sidebar active state: exact match, plus the SMS section's sub-routes keep "SMS" highlighted. */
export function isNavActive(pathname: string, href: string): boolean {
  if (pathname === href) return true
  return href === "/dashboard/sms" && pathname.startsWith("/dashboard/sms/")
}

// Order matters twice: it is the display order inside each group, AND
// pickFirstVisiblePath() walks it to choose a landing page. Feature-gated and
// notLanding items are never landing pages, so they can sit anywhere.
export const menuItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: Layers },
  // Buy
  { href: "/dashboard/data-packages", label: "Data Packages", icon: Package, cap: "buy.data", group: "buy" },
  { href: "/dashboard/standard-bundles", label: "Standard Bundles", icon: Package, cap: "buy.data", subAgent: true, feature: "standard-bundles", group: "buy" },
  { href: "/dashboard/airtime", label: "Buy Airtime", icon: Smartphone, cap: "buy.airtime", group: "buy" },
  { href: "/dashboard/bills", label: "Utility Bills", icon: Lightbulb, cap: "buy.bills", subAgent: true, feature: "bills", group: "buy" },
  { href: "/dashboard/broadband", label: "Telecel Broadband", icon: Wifi, cap: "buy.bills", subAgent: true, feature: "broadband", group: "buy" },
  { href: "/dashboard/results-checker", label: "Results Checker", icon: GraduationCap, cap: "buy.results", subAgent: true, group: "buy" },
  { href: "/dashboard/results-check", label: "Check Results", icon: GraduationCap, cap: "buy.results", subAgent: true, group: "buy" },
  // Orders & Money
  { href: "/dashboard/my-orders", label: "My Orders", icon: ShoppingCart, cap: "account.wallet", group: "orders" },
  { href: "/dashboard/afa-orders", label: "AFA Orders", icon: IdCard, cap: "buy.afa", group: "orders" },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet, cap: "account.wallet", subAgent: true, group: "orders" },
  { href: "/dashboard/transactions", label: "Transactions", icon: History, cap: "account.wallet", group: "orders" },
  // Account
  { href: "/dashboard/top-performers", label: "Top Performers", icon: Trophy, cap: "account.leaderboard", subAgent: true, notLanding: true, group: "account" },
  { href: "/dashboard/profile", label: "Profile", icon: User, subAgent: true, group: "account" },
  { href: "/dashboard/developer", label: "Developer / API", icon: Code2, cap: "account.api", subAgent: true, group: "account" },
  { href: "/dashboard/complaints", label: "Support & Complaints", icon: AlertCircle, group: "account" },
  { href: "/dashboard/upgrade", label: "Upgrade to Dealer", icon: Sparkles, cap: "account.upgrade", group: "account" },
]

export const shopItems: NavItem[] = [
  { href: "/dashboard/my-shop", label: "Overview", icon: Store, cap: "shop.storefront", subAgent: true },
  { href: "/dashboard/shop-orders", label: "Orders", icon: ShoppingCart, cap: "shop.storefront", subAgent: true },
  { href: "/dashboard/customers", label: "Customers", icon: Users, cap: "shop.storefront", subAgent: true },
  { href: "/dashboard/text-orders", label: "Text Orders", icon: MessageSquareText, cap: "shop.text_orders", subAgent: true },
  { href: "/dashboard/blocked-numbers", label: "Blocked Numbers", icon: ShieldAlert, cap: "shop.storefront", subAgent: true },
  { href: "/dashboard/shop-profit-logs", label: "Profit Logs", icon: Activity, cap: "shop.storefront", subAgent: true },
  { href: "/dashboard/shop-pricing", label: "Pricing", icon: Tag, cap: "shop.storefront", subAgent: true },
  { href: "/dashboard/sms", label: "SMS", icon: Send, cap: "shop.sms", subAgent: true },
  { href: "/dashboard/shop-withdraw", label: "Withdraw", icon: Banknote, cap: "shop.storefront", subAgent: true },
  { href: "/dashboard/shop-profile", label: "Shop Profile", icon: Settings, cap: "shop.storefront", subAgent: true },
  { href: "/dashboard/ussd-shop", label: "USSD/WhatsApp Bot", icon: Smartphone, cap: "shop.bots", subAgent: true },
  { href: "/dashboard/payment-reverify", label: "Payment Reverify", icon: Zap, cap: "shop.storefront", subAgent: true },
  { href: "/dashboard/sub-agents", label: "Sub-Agents", icon: Users, cap: "shop.subagents" },
  { href: "/dashboard/sub-agent-catalog", label: "Sub-Agent Catalog", icon: Package, cap: "shop.subagents" },
  { href: "/dashboard/buy-stock", label: "Buy Data", icon: ShoppingBag, subAgentOnly: true },
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
  rights: RoleRights,
  services: DomainService[] | null,
  hiddenPages: string[],
  dealerHasSubscription: boolean
): string | null {
  if (!role) return null
  const allItems = [...menuItems, ...shopItems]
  for (const item of allItems) {
    if (!navVisible(item, role, rights)) continue
    if (item.feature) continue // availability is client-side; never a landing page
    if (item.notLanding) continue
    if (item.href === "/dashboard" && isPageHidden("dashboard_home", hiddenPages)) continue
    if (item.href === "/dashboard/upgrade" && role === "dealer" && !dealerHasSubscription) continue
    if (!isPathAllowedForService(item.href, services, hiddenPages)) continue
    return item.href
  }
  return null
}

// ---------------------------------------------------------------------------
// Admin sidebar section (admins only; the sidebar gates on useIsAdmin()).
// To add an admin page: add one line to `adminNavItems` under the right group.
// A NEW tag needs only its href in lib/nav-new.ts; the sidebar does the rest.
// ---------------------------------------------------------------------------

/** Runtime counters the sidebar shows as a pill beside an admin link. */
export type AdminNavBadge = "pendingOrders" | "whatsappUnread"

export interface AdminNavItem {
  href: string
  label: string
  icon: LucideIcon
  group: string
  badge?: AdminNavBadge
}

export const adminNavGroups: readonly NavGroupDef[] = [
  { id: "admin-overview", label: "Overview" },
  { id: "admin-money", label: "Money & Payments" },
  { id: "admin-services", label: "Services" },
  { id: "admin-mtn", label: "MTN & Phones" },
  { id: "admin-channels", label: "Messaging & Bots" },
  { id: "admin-ai", label: "AI" },
  { id: "admin-system", label: "System" },
]

export const adminNavItems: readonly AdminNavItem[] = [
  { href: "/admin", label: "Admin Panel", icon: Lock, group: "admin-overview" },
  { href: "/admin/orders", label: "Orders", icon: Download, group: "admin-overview", badge: "pendingOrders" },
  { href: "/admin/transactions", label: "Transactions", icon: ArrowRightLeft, group: "admin-overview" },
  { href: "/admin/leaderboard", label: "Leaderboard Rewards", icon: Trophy, group: "admin-overview" },

  { href: "/admin/gateway", label: "Payment Gateway", icon: CreditCard, group: "admin-money" },
  { href: "/admin/refunds", label: "Refunds", icon: RotateCcw, group: "admin-money" },
  { href: "/admin/withdrawal-history", label: "Withdrawal History", icon: History, group: "admin-money" },
  { href: "/admin/payment-attempts", label: "Payment Attempts", icon: Receipt, group: "admin-money" },
  { href: "/admin/payment-reverify", label: "Payment Reverify", icon: BadgeCheck, group: "admin-money" },
  { href: "/admin/momo-claims", label: "MoMo Claims", icon: HandCoins, group: "admin-money" },
  { href: "/admin/subscriptions", label: "Dealer Plans", icon: Crown, group: "admin-money" },
  { href: "/admin/subscribers", label: "Subscribers", icon: Users, group: "admin-money" },

  { href: "/admin/airtime", label: "Airtime Management", icon: Signal, group: "admin-services" },
  { href: "/admin/airtime/settings", label: "Airtime Settings", icon: Settings, group: "admin-services" },
  { href: "/admin/results-checker", label: "Results Checker", icon: GraduationCap, group: "admin-services" },
  { href: "/admin/results-check-requests", label: "Check Requests", icon: ClipboardCheck, group: "admin-services" },
  { href: "/admin/hubtel-commission", label: "Hubtel Commission", icon: Percent, group: "admin-services" },
  { href: "/admin/utility-bills", label: "Utility Bills", icon: Lightbulb, group: "admin-services" },

  { href: "/admin/settings/mtn", label: "MTN Settings", icon: Zap, group: "admin-mtn" },
  { href: "/admin/mtn-registration", label: "MTN Registration", icon: SmartphoneNfc, group: "admin-mtn" },
  { href: "/admin/phone-verification", label: "Phone Verification", icon: Phone, group: "admin-mtn" },
  { href: "/admin/user-phone-audit", label: "User Phone Audit", icon: PhoneOff, group: "admin-mtn" },
  { href: "/admin/blocked-numbers", label: "Blocked Numbers", icon: Ban, group: "admin-mtn" },

  { href: "/admin/whatsapp", label: "WhatsApp Inbox", icon: MessageCircle, group: "admin-channels", badge: "whatsappUnread" },
  { href: "/admin/text-to-buy", label: "Text-to-Buy", icon: MessageSquareText, group: "admin-channels" },
  { href: "/admin/ussd-shops", label: "USSD Shops", icon: Store, group: "admin-channels" },
  { href: "/admin/ussd-hubtel", label: "Hubtel USSD", icon: Hash, group: "admin-channels" },
  { href: "/admin/sms", label: "SMS Platform", icon: MessageSquare, group: "admin-channels" },
  { href: "/admin/sms-centre", label: "SMS Centre", icon: Send, group: "admin-channels" },
  { href: "/admin/sms-health", label: "SMS Health", icon: Activity, group: "admin-channels" },

  { href: "/admin/ai-settings", label: "AI Settings", icon: Sparkles, group: "admin-ai" },
  { href: "/admin/ai-knowledge", label: "AI Knowledge", icon: BookOpen, group: "admin-ai" },

  { href: "/admin/settings", label: "Settings", icon: Settings, group: "admin-system" },
  { href: "/admin/security", label: "Security", icon: Shield, group: "admin-system" },
  { href: "/admin/api-keys", label: "API Control", icon: Code2, group: "admin-system" },
  { href: "/admin/rate-limits", label: "Rate Limits", icon: Gauge, group: "admin-system" },
  { href: "/admin/scheduled-tasks", label: "Scheduled Tasks", icon: Clock, group: "admin-system" },
  { href: "/admin/custom-domains", label: "Custom Domains", icon: Globe, group: "admin-system" },
]
