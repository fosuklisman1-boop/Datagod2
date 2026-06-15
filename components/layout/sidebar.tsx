"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { supabase } from "@/lib/supabase"
import { useIsAdmin } from "@/hooks/use-admin"
import { useAppSettings } from "@/hooks/use-app-settings"
import { useAuth } from "@/hooks/use-auth"
import {
  Home,
  Package,
  ShoppingCart,
  Star,
  Wallet,
  History,
  User,
  AlertCircle,
  MessageCircle,
  LogOut,
  Store,
  TrendingUp,
  Settings,
  Download,
  ChevronLeft,
  ChevronRight,
  Menu,
  Loader2,
  Lock,
  ArrowRightLeft,
  Clock,
  Users,
  ShoppingBag,
  Zap,
  Crown,
  Sparkles,
  Smartphone,
  Activity,
  Shield,
  GraduationCap,
  Phone,
  PhoneOff,
  ClipboardCheck,
  BookOpen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState, useEffect } from "react"
import { Badge } from "@/components/ui/badge"

// Format large numbers with K/M suffix
const formatCount = (num: number): string => {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (num >= 10000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toLocaleString()
}

const menuItems = [
  { href: "/dashboard", label: "Dashboard", icon: Home, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/data-packages", label: "Data Packages", icon: Package, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/airtime", label: "Buy Airtime", icon: Smartphone, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/results-checker", label: "Results Checker", icon: GraduationCap, roles: ["user", "admin", "dealer", "sub_agent"] },
  { href: "/dashboard/my-orders", label: "My Orders", icon: ShoppingCart, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/afa-orders", label: "AFA Orders", icon: Star, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/transactions", label: "Transactions", icon: History, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/profile", label: "Profile", icon: User, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/complaints", label: "My Complaints", icon: AlertCircle, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/upgrade", label: "Upgrade to Dealer", icon: Sparkles, roles: ["user", "admin", "dealer"] },
]

const shopItems = [
  { href: "/dashboard/my-shop", label: "My Shop", icon: Store, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-dashboard", label: "Shop Dashboard", icon: TrendingUp, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/ussd-shop", label: "USSD Shop", icon: Smartphone, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/payment-reverify", label: "Payment Reverify", icon: Zap, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/sub-agents", label: "Sub-Agents", icon: Users, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/sub-agent-catalog", label: "Sub-Agent Catalog", icon: Package, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/buy-stock", label: "Buy Data", icon: ShoppingBag, roles: ["sub_agent"] },
]

export function Sidebar() {
  const pathname = usePathname()
  const { isAdmin } = useIsAdmin()
  const { joinCommunityLink } = useAppSettings()
  const { logout, user } = useAuth()
  const [isOpen, setIsOpen] = useState(true)
  const [isMobile, setIsMobile] = useState(false)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [userPendingOrderCount, setUserPendingOrderCount] = useState(0)
  const [adminPendingOrderCount, setAdminPendingOrderCount] = useState(0)
  const [waUnreadCount, setWaUnreadCount] = useState(0)
  const [waUnreadCapped, setWaUnreadCapped] = useState(false)
  const [userRole, setUserRole] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('userRole')
    }
    return null
  })
  const [dealerHasSubscription, setDealerHasSubscription] = useState(false)
  const [roleLoading, setRoleLoading] = useState(true)

  const handleLogout = async () => {
    await logout()
  }

  // Fetch user role
  useEffect(() => {
    if (!user) {
      setRoleLoading(false)
      return
    }

    const fetchRole = async () => {
      try {
        setRoleLoading(true)
        const { data: userData } = await supabase
          .from("users")
          .select("role")
          .eq("id", user.id)
          .single()

        if (userData?.role) {
          setUserRole(userData.role)
          localStorage.setItem('userRole', userData.role)
          console.log("[SIDEBAR] User role from users table:", userData.role)

          if (userData.role === 'dealer') {
            const { data: sub } = await supabase
              .from("user_subscriptions")
              .select("id")
              .eq("user_id", user.id)
              .eq("status", "active")
              .maybeSingle()
            setDealerHasSubscription(!!sub)
          }
        } else {
          // Fallback: check user_metadata
          const { data: { user: authUser } } = await supabase.auth.getUser()
          const metadataRole = authUser?.user_metadata?.role
          if (metadataRole) {
            setUserRole(metadataRole)
            localStorage.setItem('userRole', metadataRole)
            console.log("[SIDEBAR] User role from metadata:", metadataRole)
          } else {
            setUserRole("user")
            localStorage.setItem('userRole', "user")
          }
        }
      } catch (error) {
        console.error("Error fetching user role:", error)
        setUserRole("user")
      } finally {
        setRoleLoading(false)
      }
    }

    fetchRole()
  }, [user])

  // Fetch pending orders count from localStorage
  useEffect(() => {
    if (!user) {
      console.log('[SIDEBAR] No user yet, waiting...')
      return
    }

    // Only update state when counts actually change to avoid needless re-renders
    const handleStorageChange = () => {
      const next = parseInt(localStorage.getItem('userPendingOrdersCount') || '0', 10)
      const nextAdmin = parseInt(localStorage.getItem('adminPendingOrdersCount') || '0', 10)
      setUserPendingOrderCount(prev => prev !== next ? next : prev)
      setAdminPendingOrderCount(prev => prev !== nextAdmin ? nextAdmin : prev)
    }

    // Check localStorage immediately
    handleStorageChange()

    // Listen for storage events (from other tabs/components)
    window.addEventListener('storage', handleStorageChange)

    // Also poll localStorage every 15 seconds in case it changes in same tab
    const interval = setInterval(handleStorageChange, 15000)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
      clearInterval(interval)
    }
  }, [user])

  // Poll the WhatsApp inbox unread count for admins (badge on the inbox link).
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    const load = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.access_token) return
        const res = await fetch("/api/admin/whatsapp-inbox/unread-count", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) {
          setWaUnreadCount(typeof json.count === "number" ? json.count : 0)
          setWaUnreadCapped(json.capped === true)
        }
      } catch { /* transient */ }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [isAdmin])

  // Handle mobile responsiveness
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
      if (window.innerWidth < 768) {
        setIsOpen(false)
      }
    }

    handleResize()
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  // Emit sidebar state change event
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sidebarStateChange', { detail: { isOpen, isMobile } }));
    }
  }, [isOpen, isMobile]);

  // Clear loading state when pathname changes
  useEffect(() => {
    setLoadingPath(null)
  }, [pathname])

  const handleNavigation = (href: string) => {
    if (pathname !== href) {
      setLoadingPath(href)
    }
  }
  return (
    <>
      {/* Mobile Toggle Button */}
      {isMobile && (
        <Button
          onClick={() => setIsOpen(!isOpen)}
          variant="ghost"
          size="icon"
          className={cn(
            "fixed top-4 left-4 z-50 md:hidden bg-primary text-primary-foreground hover:bg-primary/90 transition-opacity duration-300",
            isOpen && "opacity-0 pointer-events-none"
          )}
        >
          <Menu className="w-5 h-5" />
        </Button>
      )}

      {/* Overlay for mobile */}
      {isMobile && isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={cn(
          "h-screen flex flex-col fixed left-0 top-0 z-40 transition-all duration-300 ease-in-out",
          userRole === 'dealer'
            ? "bg-gradient-to-b from-[#1d1140] via-[#37146b] to-[#7c1bd6] text-white"
            : "bg-sidebar text-sidebar-foreground border-r border-sidebar-border",
          isOpen ? "w-64" : "w-20",
          isMobile && !isOpen && "-translate-x-full"
        )}
      >
        {/* Logo Section */}
        <div className={cn(
          "p-6 border-b",
          userRole === 'dealer' ? "border-white/10" : "border-sidebar-border"
        )}>
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="bg-white p-2 rounded-lg flex-shrink-0 relative">
              <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-6 h-6 rounded-lg object-cover" />
              {userRole === 'dealer' && (
                <div className="absolute -top-3 -right-3 rotate-12">
                  <Crown className="w-5 h-5 text-amber-600 fill-amber-500 drop-shadow-md" />
                </div>
              )}
            </div>
            {isOpen && (
              <div>
                <h1 className="text-xl font-bold">DATAGOD</h1>
                <p className={cn(
                  "text-xs",
                  userRole === 'dealer' ? "text-purple-100" : "text-muted-foreground"
                )}>{user?.email || "User"}</p>
              </div>
            )}
          </Link>
        </div>

        {/* Collapse Button */}
        {!isMobile && (
          <div className="px-4 pt-2">
            <Button
              onClick={() => setIsOpen(!isOpen)}
              variant="ghost"
              size="icon"
              className={cn(
                "w-full flex justify-center",
                userRole === 'dealer' ? "text-white hover:bg-white/10" : "text-sidebar-foreground hover:bg-accent"
              )}
              title={isOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              {isOpen ? (
                <ChevronLeft className="w-5 h-5" />
              ) : (
                <ChevronRight className="w-5 h-5" />
              )}
            </Button>
          </div>
        )}

        {/* Navigation Menu */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-2 scrollbar-thin scrollbar-thumb-blue-400 scrollbar-track-blue-600 hover:scrollbar-thumb-blue-300">
          {roleLoading ? (
            // Show loading skeleton while fetching role
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-10 bg-muted rounded animate-pulse" />
              ))}
            </div>
          ) : (
            menuItems.filter(item => {
            if (!userRole || !item.roles.includes(userRole)) return false
            // Hide upgrade page for dealers with no subscription end-date (permanent dealers)
            if (item.href === '/dashboard/upgrade' && userRole === 'dealer' && !dealerHasSubscription) return false
            return true
          }).map((item) => {
              const Icon = item.icon
              const isActive = pathname === item.href
              const isLoading = loadingPath === item.href
              const showBadge = item.label === "My Orders" && userPendingOrderCount > 0

              return (
                <Link key={item.href} href={item.href} onClick={() => handleNavigation(item.href)}>
                  <Button
                    variant="ghost"
                    className={cn(
                      "w-full justify-start gap-3 transition-all duration-200",
                      userRole === 'dealer'
                        ? (isActive ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                        : (isActive ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                      !isOpen && "justify-center",
                      isLoading && "opacity-70"
                    )}
                    title={!isOpen ? item.label : undefined}
                    disabled={isLoading}
                    data-tour={item.label === "Wallet" ? "wallet-topup" : undefined}
                  >
                    {isLoading ? (
                      <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                    ) : (
                      <Icon className="w-5 h-5 flex-shrink-0" />
                    )}
                    {isOpen && (
                      <div className="flex items-center justify-between flex-1">
                        <span>{item.label}</span>
                        {showBadge && (
                          <Badge className="bg-red-500 hover:bg-red-600 text-white text-xs ml-2">
                            {formatCount(userPendingOrderCount)}
                          </Badge>
                        )}
                      </div>
                    )}
                  </Button>
                </Link>
              )
            })
          )}

          {/* Shop Section */}
          {!roleLoading && (
            <div className={cn(
              "pt-4 mt-4 border-t",
              userRole === 'dealer' ? "border-white/10" : "border-sidebar-border"
            )}>
              {isOpen && (
                <p className={cn(
                  "text-xs font-semibold px-3 mb-2",
                  userRole === 'dealer' ? "text-purple-200/80" : "text-muted-foreground"
                )}>SHOP</p>
              )}
              {shopItems.filter(item => userRole && item.roles.includes(userRole)).map((item) => {
                const Icon = item.icon
                const isActive = pathname === item.href
                const isLoading = loadingPath === item.href
                return (
                  <Link key={item.href} href={item.href} onClick={() => handleNavigation(item.href)}>
                    <Button
                      variant="ghost"
                      className={cn(
                        "w-full justify-start gap-3 transition-all duration-200",
                        userRole === 'dealer'
                          ? (isActive ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                          : (isActive ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                        !isOpen && "justify-center",
                        isLoading && "opacity-70"
                      )}
                      title={!isOpen ? item.label : undefined}
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                      ) : (
                        <Icon className="w-5 h-5 flex-shrink-0" />
                      )}
                      {isOpen && item.label}
                    </Button>
                  </Link>
                )
              })}
            </div>
          )}

          {/* Admin Section */}
          {isAdmin && (
            <div className={cn(
              "pt-4 mt-4 border-t",
              userRole === 'dealer' ? "border-white/10" : "border-sidebar-border"
            )}>
              {isOpen && (
                <p className={cn(
                  "text-xs font-semibold px-3 mb-2",
                  userRole === 'dealer' ? "text-purple-200/80" : "text-muted-foreground"
                )}>ADMIN</p>
              )}
              <Link href="/admin" onClick={() => handleNavigation("/admin")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin" && "opacity-70"
                  )}
                  title={!isOpen ? "Admin Panel" : undefined}
                  disabled={loadingPath === "/admin"}
                >
                  {loadingPath === "/admin" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Lock className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Admin Panel"}
                </Button>
              </Link>
              <Link href="/admin/settings" onClick={() => handleNavigation("/admin/settings")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/settings" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/settings" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/settings" && "opacity-70"
                  )}
                  title={!isOpen ? "Settings" : undefined}
                  disabled={loadingPath === "/admin/settings"}
                >
                  {loadingPath === "/admin/settings" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Settings className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Settings"}
                </Button>
              </Link>

              <Link href="/admin/settings/mtn" onClick={() => handleNavigation("/admin/settings/mtn")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/settings/mtn" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/settings/mtn" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/settings/mtn" && "opacity-70"
                  )}
                  title={!isOpen ? "MTN Settings" : undefined}
                  disabled={loadingPath === "/admin/settings/mtn"}
                >
                  {loadingPath === "/admin/settings/mtn" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Zap className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "MTN Settings"}
                </Button>
              </Link>

              <Link href="/admin/sms-health" onClick={() => handleNavigation("/admin/sms-health")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/sms-health" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/sms-health" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/sms-health" && "opacity-70"
                  )}
                  title={!isOpen ? "SMS Health" : undefined}
                  disabled={loadingPath === "/admin/sms-health"}
                >
                  {loadingPath === "/admin/sms-health" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <MessageCircle className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "SMS Health"}
                </Button>
              </Link>

              <Link href="/admin/ai-settings" onClick={() => handleNavigation("/admin/ai-settings")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/ai-settings" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/ai-settings" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/ai-settings" && "opacity-70"
                  )}
                  title={!isOpen ? "AI Settings" : undefined}
                  disabled={loadingPath === "/admin/ai-settings"}
                >
                  {loadingPath === "/admin/ai-settings" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Sparkles className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "AI Settings"}
                </Button>
              </Link>

              <Link href="/admin/scheduled-tasks" onClick={() => handleNavigation("/admin/scheduled-tasks")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/scheduled-tasks" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/scheduled-tasks" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/scheduled-tasks" && "opacity-70"
                  )}
                  title={!isOpen ? "Scheduled Tasks" : undefined}
                  disabled={loadingPath === "/admin/scheduled-tasks"}
                >
                  {loadingPath === "/admin/scheduled-tasks" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Clock className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Scheduled Tasks"}
                </Button>
              </Link>

              <Link href="/admin/subscriptions" onClick={() => handleNavigation("/admin/subscriptions")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/subscriptions" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/subscriptions" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/subscriptions" && "opacity-70"
                  )}
                  title={!isOpen ? "Dealer Plans" : undefined}
                  disabled={loadingPath === "/admin/subscriptions"}
                >
                  {loadingPath === "/admin/subscriptions" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Crown className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Dealer Plans"}
                </Button>
              </Link>
              <Link href="/admin/subscribers" onClick={() => handleNavigation("/admin/subscribers")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/subscribers" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/subscribers" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/subscribers" && "opacity-70"
                  )}
                  title={!isOpen ? "Subscribers" : undefined}
                  disabled={loadingPath === "/admin/subscribers"}
                >
                  {loadingPath === "/admin/subscribers" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Users className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Subscribers"}
                </Button>
              </Link>
              <Link href="/admin/orders" onClick={() => handleNavigation("/admin/orders")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/orders" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/orders" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/orders" && "opacity-70"
                  )}
                  title={!isOpen ? "Orders" : undefined}
                  disabled={loadingPath === "/admin/orders"}
                >
                  {loadingPath === "/admin/orders" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Download className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && (
                    <div className="flex items-center justify-between flex-1">
                      <span>Orders</span>
                      {adminPendingOrderCount > 0 && (
                        <Badge className="bg-red-500 hover:bg-red-600 text-white text-xs ml-2">
                          {formatCount(adminPendingOrderCount)}
                        </Badge>
                      )}
                    </div>
                  )}
                </Button>
              </Link>

              <Link href="/admin/api-keys" onClick={() => handleNavigation("/admin/api-keys")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/api-keys" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/api-keys" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/api-keys" && "opacity-70"
                  )}
                  title={!isOpen ? "API Control" : undefined}
                  disabled={loadingPath === "/admin/api-keys"}
                >
                  {loadingPath === "/admin/api-keys" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Activity className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "API Control"}
                </Button>
              </Link>

              <Link href="/admin/rate-limits" onClick={() => handleNavigation("/admin/rate-limits")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/rate-limits" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/rate-limits" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/rate-limits" && "opacity-70"
                  )}
                  title={!isOpen ? "Rate Limits" : undefined}
                  disabled={loadingPath === "/admin/rate-limits"}
                >
                  {loadingPath === "/admin/rate-limits" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Shield className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Rate Limits"}
                </Button>
              </Link>

              <Link href="/admin/withdrawal-history" onClick={() => handleNavigation("/admin/withdrawal-history")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/withdrawal-history" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/withdrawal-history" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/withdrawal-history" && "opacity-70"
                  )}
                  title={!isOpen ? "Withdrawal History" : undefined}
                  disabled={loadingPath === "/admin/withdrawal-history"}
                >
                  {loadingPath === "/admin/withdrawal-history" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <History className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Withdrawal History"}
                </Button>
              </Link>

              <Link href="/admin/phone-verification" onClick={() => handleNavigation("/admin/phone-verification")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/phone-verification" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/phone-verification" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/phone-verification" && "opacity-70"
                  )}
                  title={!isOpen ? "Phone Verification" : undefined}
                  disabled={loadingPath === "/admin/phone-verification"}
                >
                  {loadingPath === "/admin/phone-verification" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Phone className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Phone Verification"}
                </Button>
              </Link>

              <Link href="/admin/user-phone-audit" onClick={() => handleNavigation("/admin/user-phone-audit")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/user-phone-audit" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/user-phone-audit" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/user-phone-audit" && "opacity-70"
                  )}
                  title={!isOpen ? "User Phone Audit" : undefined}
                  disabled={loadingPath === "/admin/user-phone-audit"}
                >
                  {loadingPath === "/admin/user-phone-audit" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <PhoneOff className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "User Phone Audit"}
                </Button>
              </Link>

              <Link href="/admin/airtime" onClick={() => handleNavigation("/admin/airtime")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/airtime" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/airtime" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/airtime" && "opacity-70"
                  )}
                  title={!isOpen ? "Airtime Management" : undefined}
                  disabled={loadingPath === "/admin/airtime"}
                >
                  {loadingPath === "/admin/airtime" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Smartphone className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Airtime Management"}
                </Button>
              </Link>
              <Link href="/admin/airtime/settings" onClick={() => handleNavigation("/admin/airtime/settings")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/airtime/settings" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/airtime/settings" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/airtime/settings" && "opacity-70"
                  )}
                  title={!isOpen ? "Airtime Settings" : undefined}
                  disabled={loadingPath === "/admin/airtime/settings"}
                >
                  {loadingPath === "/admin/airtime/settings" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Settings className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Airtime Settings"}
                </Button>
              </Link>
              <Link href="/admin/results-checker" onClick={() => handleNavigation("/admin/results-checker")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/results-checker" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/results-checker" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/results-checker" && "opacity-70"
                  )}
                  title={!isOpen ? "Results Checker" : undefined}
                  disabled={loadingPath === "/admin/results-checker"}
                >
                  {loadingPath === "/admin/results-checker" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <GraduationCap className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Results Checker"}
                </Button>
              </Link>
              <Link href="/admin/results-check-requests" onClick={() => handleNavigation("/admin/results-check-requests")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/results-check-requests" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/results-check-requests" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/results-check-requests" && "opacity-70"
                  )}
                  title={!isOpen ? "Check Requests" : undefined}
                  disabled={loadingPath === "/admin/results-check-requests"}
                >
                  {loadingPath === "/admin/results-check-requests" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <ClipboardCheck className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Check Requests"}
                </Button>
              </Link>
              <Link href="/admin/whatsapp" onClick={() => handleNavigation("/admin/whatsapp")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/whatsapp" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/whatsapp" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/whatsapp" && "opacity-70"
                  )}
                  title={!isOpen ? "WhatsApp Inbox" : undefined}
                  disabled={loadingPath === "/admin/whatsapp"}
                >
                  {loadingPath === "/admin/whatsapp" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <MessageCircle className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && (
                    <div className="flex items-center justify-between flex-1">
                      <span>WhatsApp Inbox</span>
                      {waUnreadCount > 0 && (
                        <Badge className="bg-emerald-500 hover:bg-emerald-600 text-white text-xs ml-2">
                          {formatCount(waUnreadCount)}{waUnreadCapped ? "+" : ""}
                        </Badge>
                      )}
                    </div>
                  )}
                </Button>
              </Link>
              <Link href="/admin/ai-knowledge" onClick={() => handleNavigation("/admin/ai-knowledge")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/ai-knowledge" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/ai-knowledge" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/ai-knowledge" && "opacity-70"
                  )}
                  title={!isOpen ? "AI Knowledge" : undefined}
                  disabled={loadingPath === "/admin/ai-knowledge"}
                >
                  {loadingPath === "/admin/ai-knowledge" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <BookOpen className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "AI Knowledge"}
                </Button>
              </Link>
              <Link href="/admin/transactions" onClick={() => handleNavigation("/admin/transactions")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/transactions" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/transactions" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/transactions" && "opacity-70"
                  )}
                  title={!isOpen ? "Transactions" : undefined}
                  disabled={loadingPath === "/admin/transactions"}
                >
                  {loadingPath === "/admin/transactions" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <ArrowRightLeft className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Transactions"}
                </Button>
              </Link>
              <Link href="/admin/payment-attempts" onClick={() => handleNavigation("/admin/payment-attempts")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/payment-attempts" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/payment-attempts" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/payment-attempts" && "opacity-70"
                  )}
                  title={!isOpen ? "Payment Attempts" : undefined}
                  disabled={loadingPath === "/admin/payment-attempts"}
                >
                  {loadingPath === "/admin/payment-attempts" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Clock className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Payment Attempts"}
                </Button>
              </Link>
              <Link href="/admin/payment-reverify" onClick={() => handleNavigation("/admin/payment-reverify")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/payment-reverify" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/payment-reverify" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/payment-reverify" && "opacity-70"
                  )}
                  title={!isOpen ? "Payment Reverify" : undefined}
                  disabled={loadingPath === "/admin/payment-reverify"}
                >
                  {loadingPath === "/admin/payment-reverify" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Zap className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Payment Reverify"}
                </Button>
              </Link>
              <Link href="/admin/ussd-shops" onClick={() => handleNavigation("/admin/ussd-shops")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/ussd-shops" ? "bg-white/15 text-white shadow-lg" : "text-purple-100 hover:bg-white/10")
                      : (pathname === "/admin/ussd-shops" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/ussd-shops" && "opacity-70"
                  )}
                  title={!isOpen ? "USSD Shops" : undefined}
                  disabled={loadingPath === "/admin/ussd-shops"}
                >
                  {loadingPath === "/admin/ussd-shops" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Smartphone className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "USSD Shops"}
                </Button>
              </Link>
            </div>
          )}

        </nav >

        {/* Community & Logout */}
        < div className={
          cn(
            "p-4 pb-24 md:pb-4 border-t space-y-2",
            userRole === 'dealer' ? "border-white/10" : "border-sidebar-border"
          )
        }>
          {joinCommunityLink && (
            <Button
              variant="ghost"
              className={cn(
                "w-full justify-start gap-3 text-white bg-green-600 hover:bg-green-700",
                !isOpen && "justify-center"
              )}
              asChild
              title={!isOpen ? "Join Community" : undefined}
            >
              <a href={joinCommunityLink} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="w-5 h-5 flex-shrink-0" />
                {isOpen && "Join Community"}
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            className={cn(
              "w-full justify-start gap-3",
              userRole === 'dealer' ? "text-white hover:bg-red-500/30" : "text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive",
              !isOpen && "justify-center"
            )}
            onClick={handleLogout}
            title={!isOpen ? "Logout" : undefined}
          >
            <LogOut className="w-5 h-5 flex-shrink-0" />
            {isOpen && "Logout"}
          </Button>
        </div >
      </div >
    </>
  )
}
