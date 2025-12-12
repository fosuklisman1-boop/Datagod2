"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

const INACTIVITY_TIMEOUT = 12 * 60 * 60 * 1000 // 12 hours in milliseconds

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

      // Set warning timeout (9 minutes)
      warningTimeoutRef.current = setTimeout(() => {
        toast.warning("You will be logged out in 1 minute due to inactivity")
      }, (INACTIVITY_TIMEOUT - 60 * 1000))

      // Set logout timeout (10 minutes)
      timeoutRef.current = setTimeout(async () => {
        try {
          // Logout user
          await supabase.auth.signOut()
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
