"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

const INACTIVITY_TIMEOUT = 4 * 60 * 60 * 1000 // 4 hours in milliseconds

export function useInactivityLogout() {
  const router = useRouter()
  const { user } = useAuth()
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const warningTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (!user) return

    // Reset timeout on any user activity
    const resetTimeout = () => {
      // Clear existing timeouts
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (warningTimeoutRef.current) clearTimeout(warningTimeoutRef.current)

      // Set warning timeout (fires 1 minute before logout)
      warningTimeoutRef.current = setTimeout(() => {
        toast.warning("You will be logged out in 1 minute due to inactivity")
      }, (INACTIVITY_TIMEOUT - 60 * 1000))

      // Set logout timeout (4 hours)
      timeoutRef.current = setTimeout(async () => {
        try {
          // Global scope revokes the refresh token server-side so the session
          // cannot be silently re-used from another tab or device.
          await supabase.auth.signOut({ scope: "global" })
          toast.info("You have been logged out due to inactivity")
          router.push("/auth/login")
        } catch (error) {
          console.error("Error logging out:", error)
        }
      }, INACTIVITY_TIMEOUT)
    }

    // Track various user activity events
    const events = ["mousedown", "keydown", "scroll", "touchstart", "click"]
    
    events.forEach((event) => {
      window.addEventListener(event, resetTimeout)
    })

    // Initial timeout setup
    resetTimeout()

    // Cleanup
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (warningTimeoutRef.current) clearTimeout(warningTimeoutRef.current)
      events.forEach((event) => {
        window.removeEventListener(event, resetTimeout)
      })
    }
  }, [user, router])
}
