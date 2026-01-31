"use client"

import { ShoppingCart, User, LogOut, Headphones, Mail, Phone, MessageCircle, Crown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { NotificationCenter } from "@/components/notification-center"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAuth } from "@/hooks/use-auth"
import { useUserRole } from "@/hooks/use-user-role"
import { useSupportConfig } from "@/hooks/use-support-config"
import { supportConfig } from "@/lib/support-config"
import { toast } from "sonner"
import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"

export function Header() {
  const { user, logout } = useAuth()
  const { isDealer } = useUserRole()
  const { config: dynamicConfig } = useSupportConfig()
  const [isMobile, setIsMobile] = useState(false)
  // Use dynamic config if available, otherwise fall back to static config
  const supportInfo = dynamicConfig || supportConfig

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
    }

    handleResize()
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  const handleLogout = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await logout()
      toast.success("Logged out successfully")
    } catch (error) {
      console.error("Logout error:", error)
      const errorMessage = error instanceof Error ? error.message : "Failed to logout"
      toast.error(errorMessage)
    }
  }

  return (
    <div className="h-14 md:h-16 bg-white border-b border-gray-200 flex items-center justify-between px-2 sm:px-3 md:px-4 lg:px-6 fixed right-0 left-0 top-0 z-30 transition-all duration-300 w-full">
      {/* Left side - empty for now */}
      <div></div>

      {/* Right side - icons and user menu */}
      <div className="flex items-center gap-1 sm:gap-2 md:gap-4">
        {/* Notification Center */}
        <NotificationCenter />

        {/* Customer Support */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 md:h-10 md:w-10" title="Customer Support">
              <Headphones className="w-4 h-4 md:w-5 md:h-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <p className="font-semibold text-sm">Customer Support</p>
              <p className="text-xs text-gray-500">Get help from our team</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => window.open(`mailto:${supportInfo.email}`)}>
              <Mail className="w-4 h-4 mr-2" />
              <span>Email Support</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.open(`tel:${supportInfo.phone}`)}>
              <Phone className="w-4 h-4 mr-2" />
              <span>Call Support</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.open(supportInfo.whatsapp, "_blank")}>
              <MessageCircle className="w-4 h-4 mr-2" />
              <span>WhatsApp Chat</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Shopping Cart - hidden on mobile */}
        <Button variant="ghost" size="icon" className="relative hidden sm:inline-flex h-8 w-8 md:h-10 md:w-10">
          <ShoppingCart className="w-4 h-4 md:w-5 md:h-5" />
          <Badge className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs">0</Badge>
        </Button>

        {/* User Profile Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 md:h-10 md:w-10 relative">
              <div className={cn(
                "w-7 h-7 md:w-8 md:h-8 rounded-full flex items-center justify-center transition-all duration-300",
                isDealer
                  ? "bg-gradient-to-br from-amber-400 to-amber-600 shadow-[0_0_10px_rgba(251,191,36,0.3)]"
                  : "bg-gradient-to-br from-blue-600 to-purple-600"
              )}>
                <User className="w-3 h-3 md:w-4 md:h-4 text-white" />
              </div>
              {isDealer && (
                <div className="absolute -top-1 -right-1 rotate-12">
                  <Crown className="w-3 h-3 md:w-4 md:h-4 text-amber-500 fill-amber-300 drop-shadow-sm" />
                </div>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 sm:w-56">
            <div className="px-2 py-1.5 text-sm">
              <p className="font-semibold text-xs sm:text-sm line-clamp-1">{user?.email}</p>
              <p className="text-xs text-gray-500">Account</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs sm:text-sm">
              <User className="w-3 h-3 sm:w-4 sm:h-4 mr-2" />
              <span>Profile Settings</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs sm:text-sm">
              <span>API Keys</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleLogout}
              className="text-red-600 text-xs sm:text-sm cursor-pointer"
            >
              <LogOut className="w-3 h-3 sm:w-4 sm:h-4 mr-2" />
              <span>Logout</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
