"use client"

import { useEffect, useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import { authService } from "@/lib/auth"

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [isChecking, setIsChecking] = useState(true)

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // Get the session to ensure auth context is initialized
        const session = await authService.getSession()
        const user = session?.user || await authService.getCurrentUser()
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
      } finally {
        setIsChecking(false)
      }
    }

    checkAuth()
  }, [pathname, router])

  // Don't render until auth check is complete
  if (isChecking && pathname?.startsWith("/dashboard")) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  }

  return children
}

