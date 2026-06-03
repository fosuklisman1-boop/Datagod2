"use client"

import { useEffect, useState } from "react"
import { useRouter, usePathname } from "next/navigation"
import { authService } from "@/lib/auth"
import { supabase } from "@/lib/supabase"

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [isChecking, setIsChecking] = useState(true)

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // getSession() returns the cached local session including the user object.
        // Calling getUser() separately when no session exists triggers AuthSessionMissingError,
        // so we derive the user directly from the session.
        const session = await authService.getSession()
        const user = session?.user ?? null
        // EXEMPT the auth pages that REQUIRE an active session — otherwise we bounce
        // a just-authenticated user off them to the dashboard. Must mirror the same
        // exemptions in middleware.ts:
        //  - complete-profile: a new user finishing onboarding (logged in, no phone yet)
        //  - callback:         mid OAuth code-exchange
        //  - reset-password:   the magic link signs them in BEFORE they set a password
        const isAuthPage = pathname?.startsWith("/auth")
          && !pathname.startsWith("/auth/complete-profile")
          && !pathname.startsWith("/auth/callback")
          && !pathname.startsWith("/auth/reset-password")

        if (user && isAuthPage) {
          // User is logged in and trying to access auth pages
          // Check if user is a sub-agent
          try {
            const { data: userShop } = await supabase
              .from("user_shops")
              .select("id, parent_shop_id")
              .eq("user_id", user.id)
              .single()
            
            if (userShop?.parent_shop_id) {
              // Sub-agent - redirect to buy-stock
              router.push("/dashboard/buy-stock")
            } else {
              // Regular user/admin - redirect to dashboard
              router.push("/dashboard")
            }
          } catch {
            // Default to dashboard if check fails
            router.push("/dashboard")
          }
        } else if (!user && pathname?.startsWith("/dashboard")) {
          // User is not logged in and trying to access dashboard, redirect to login
          router.push("/auth/login")
        } else if (user && pathname === "/dashboard") {
          // User is on main dashboard - check if sub-agent
          try {
            const { data: userShop } = await supabase
              .from("user_shops")
              .select("id, parent_shop_id")
              .eq("user_id", user.id)
              .single()
            
            if (userShop?.parent_shop_id) {
              // Sub-agent trying to access main dashboard - redirect to buy-stock
              console.log("[AUTH] Sub-agent detected on main dashboard, redirecting to buy-stock")
              router.push("/dashboard/buy-stock")
            }
          } catch {
            // Continue if check fails
          }
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

