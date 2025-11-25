"use client"

import { Bell, Moon, Sun, ShoppingCart, User } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTheme } from "next-themes"
import { Badge } from "@/components/ui/badge"

export function Header() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 fixed right-0 top-0 left-64 z-40">
      {/* Left side - empty for now */}
      <div></div>

      {/* Right side - icons and user menu */}
      <div className="flex items-center gap-4">
        {/* Notification Bell */}
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="w-5 h-5" />
          <Badge className="absolute -top-1 -right-1 bg-red-500 text-white text-xs">3</Badge>
        </Button>

        {/* Theme Toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </Button>

        {/* Shopping Cart */}
        <Button variant="ghost" size="icon" className="relative">
          <ShoppingCart className="w-5 h-5" />
          <Badge className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs">0</Badge>
        </Button>

        {/* User Profile */}
        <Button variant="ghost" size="icon">
          <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-purple-600 rounded-full flex items-center justify-center">
            <User className="w-4 h-4 text-white" />
          </div>
        </Button>
      </div>
    </div>
  )
}
