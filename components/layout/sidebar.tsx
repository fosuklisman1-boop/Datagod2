"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { useIsAdmin } from "@/hooks/use-admin"
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
  Shield,
  Store,
  TrendingUp,
  Settings,
  Download,
} from "lucide-react"
import { Button } from "@/components/ui/button"

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

  return (
    <div className="w-64 bg-gradient-to-b from-blue-600 to-blue-700 text-white h-screen flex flex-col fixed left-0 top-0">
      {/* Logo Section */}
      <div className="p-6 border-b border-blue-500">
        <Link href="/dashboard" className="flex items-center gap-3">
          <div className="bg-white p-2 rounded-lg">
            <Shield className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold">DATAGOD</h1>
            <p className="text-xs text-blue-100">Data Hub</p>
          </div>
        </Link>
      </div>

      {/* Navigation Menu */}
      <nav className="flex-1 overflow-y-auto p-4 space-y-2">
        {menuItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href
          return (
            <Link key={item.href} href={item.href}>
              <Button
                variant="ghost"
                className={cn(
                  "w-full justify-start gap-3 text-white hover:bg-blue-500",
                  isActive && "bg-blue-500"
                )}
              >
                <Icon className="w-5 h-5" />
                {item.label}
              </Button>
            </Link>
          )
        })}

        {/* Shop Section */}
        <div className="pt-4 mt-4 border-t border-blue-400">
          <p className="text-xs font-semibold text-blue-100 px-3 mb-2">SHOP</p>
          {shopItems.map((item) => {
            const Icon = item.icon
            const isActive = pathname === item.href
            return (
              <Link key={item.href} href={item.href}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 text-white hover:bg-blue-500",
                    isActive && "bg-blue-500"
                  )}
                >
                  <Icon className="w-5 h-5" />
                  {item.label}
                </Button>
              </Link>
            )
          })}
        </div>

        {/* Admin Section */}
        {isAdmin && (
          <div className="pt-4 mt-4 border-t border-blue-400">
            <p className="text-xs font-semibold text-blue-100 px-3 mb-2">ADMIN</p>
            <Link href="/admin">
              <Button
                variant="ghost"
                className={cn(
                  "w-full justify-start gap-3 text-white hover:bg-blue-500",
                  pathname === "/admin" && "bg-blue-500"
                )}
              >
                <Settings className="w-5 h-5" />
                Admin Panel
              </Button>
            </Link>
            <Link href="/admin/orders">
              <Button
                variant="ghost"
                className={cn(
                  "w-full justify-start gap-3 text-white hover:bg-blue-500",
                  pathname === "/admin/orders" && "bg-blue-500"
                )}
              >
                <Download className="w-5 h-5" />
                Orders
              </Button>
            </Link>
          </div>
        )}
      </nav>

      {/* Community & Logout */}
      <div className="p-4 border-t border-blue-500 space-y-2">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-white hover:bg-blue-500 bg-green-600 hover:bg-green-700"
          asChild
        >
          <a href="https://chat.whatsapp.com/example" target="_blank" rel="noopener noreferrer">
            <MessageCircle className="w-5 h-5" />
            Join Our Community
          </a>
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-white hover:bg-red-600"
        >
          <LogOut className="w-5 h-5" />
          Logout
        </Button>
      </div>
    </div>
  )
}
