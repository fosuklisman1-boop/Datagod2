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
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState, useEffect } from "react"
import { Badge } from "@/components/ui/badge"

const menuItems = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/dashboard/data-packages", label: "Data Packages", icon: Package },
  { href: "/dashboard/my-orders", label: "My Orders", icon: ShoppingCart },
  { href: "/dashboard/afa-orders", label: "AFA Orders", icon: Star },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet },
  { href: "/dashboard/transactions", label: "Transactions", icon: History },
  { href: "/dashboard/profile", label: "Profile", icon: User },
  { href: "/dashboard/complaints", label: "My Complaints", icon: AlertCircle },
]

const shopItems = [
  { href: "/dashboard/my-shop", label: "My Shop", icon: Store },
  { href: "/dashboard/shop-dashboard", label: "Shop Dashboard", icon: TrendingUp },
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

  const handleLogout = async () => {
    await logout()
  }

  // Fetch pending orders count from localStorage
  useEffect(() => {
    if (!user) {
      console.log('[SIDEBAR] No user yet, waiting...')
      return
    }

    // Listen for changes in localStorage (read both user and admin counts separately)
    const handleStorageChange = () => {
      const userCount = localStorage.getItem('userPendingOrdersCount')
      const adminCount = localStorage.getItem('adminPendingOrdersCount')
      
      setUserPendingOrderCount(userCount ? parseInt(userCount, 10) : 0)
      setAdminPendingOrderCount(adminCount ? parseInt(adminCount, 10) : 0)
      
      console.log('[SIDEBAR] Updated counts - User:', userCount, 'Admin:', adminCount)
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
          className="fixed top-16 left-4 z-50 md:hidden bg-blue-600 text-white hover:bg-blue-700"
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
          "bg-gradient-to-b from-blue-600 to-blue-700 text-white h-screen flex flex-col fixed left-0 top-0 z-40 transition-all duration-300 ease-in-out",
          isOpen ? "w-64" : "w-20",
          isMobile && !isOpen && "-translate-x-full"
        )}
      >
        {/* Logo Section */}
        <div className="p-6 border-b border-blue-500">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="bg-white p-2 rounded-lg flex-shrink-0">
              <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-6 h-6 rounded-lg object-cover" />
            </div>
            {isOpen && (
              <div>
                <h1 className="text-xl font-bold">DATAGOD</h1>
                <p className="text-xs text-blue-100">{user?.email || "User"}</p>
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
              className="text-white hover:bg-blue-500 w-full flex justify-center"
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
          {menuItems.map((item) => {
            const Icon = item.icon
            const isActive = pathname === item.href
            const isLoading = loadingPath === item.href
            const showBadge = item.label === "My Orders" && userPendingOrderCount > 0
            
            return (
              <Link key={item.href} href={item.href} onClick={() => handleNavigation(item.href)}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 text-white hover:bg-blue-500",
                    isActive && "bg-blue-500",
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
                          {userPendingOrderCount}
                        </Badge>
                      )}
                    </div>
                  )}
                </Button>
              </Link>
            )
          })}

          {/* Shop Section */}
          <div className="pt-4 mt-4 border-t border-blue-400">
            {isOpen && (
              <p className="text-xs font-semibold text-blue-100 px-3 mb-2">SHOP</p>
            )}
            {shopItems.map((item) => {
              const Icon = item.icon
              const isActive = pathname === item.href
              const isLoading = loadingPath === item.href
              return (
                <Link key={item.href} href={item.href} onClick={() => handleNavigation(item.href)}>
                  <Button
                    variant="ghost"
                    className={cn(
                      "w-full justify-start gap-3 text-white hover:bg-blue-500",
                      isActive && "bg-blue-500",
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

          {/* Admin Section */}
          {isAdmin && (
            <div className="pt-4 mt-4 border-t border-blue-400">
              {isOpen && (
                <p className="text-xs font-semibold text-blue-100 px-3 mb-2">ADMIN</p>
              )}
              <Link href="/admin" onClick={() => handleNavigation("/admin")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 text-white hover:bg-blue-500",
                    pathname === "/admin" && "bg-blue-500",
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
                    "w-full justify-start gap-3 text-white hover:bg-blue-500",
                    pathname === "/admin/settings" && "bg-blue-500",
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
              <Link href="/admin/orders" onClick={() => handleNavigation("/admin/orders")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 text-white hover:bg-blue-500",
                    pathname === "/admin/orders" && "bg-blue-500",
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
                          {adminPendingOrderCount}
                        </Badge>
                      )}
                    </div>
                  )}
                </Button>
              </Link>
            </div>
          )}
        </nav>

        {/* Community & Logout */}
        <div className="p-4 border-t border-blue-500 space-y-2">
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
              "w-full justify-start gap-3 text-white hover:bg-red-600",
              !isOpen && "justify-center"
            )}
            onClick={handleLogout}
            title={!isOpen ? "Logout" : undefined}
          >
            <LogOut className="w-5 h-5 flex-shrink-0" />
            {isOpen && "Logout"}
          </Button>
        </div>
      </div>
    </>
  )
}
