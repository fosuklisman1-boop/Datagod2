"use client"

import { useEffect } from "react"
import { useRouter, usePathname } from "next/navigation"
import { authService } from "@/lib/auth"

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const user = await authService.getCurrentUser()
        const isAuthPage = pathname?.startsWith("/auth")
        
        if (user && isAuthPage) {
          // User is logged in and trying to access auth pages, redirect to dashboard
          router.push("/dashboard")
        } else if (!user && pathname?.startsWith("/dashboard")) {
          // User is not logged in and trying to access dashboard, redirect to login
          router.push("/auth/login")
        }
      } catch (error) {
        console.error("Auth check error:", error)
      }
    }

    checkAuth()
  }, [pathname, router])

  return children
}
