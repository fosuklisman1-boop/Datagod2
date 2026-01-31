"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

export function useUserRole() {
  const [role, setRole] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('userRole')
    }
    return null
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchRole = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()

        if (!session?.user) {
          setRole(null)
          setLoading(false)
          return
        }

        const { data: userData } = await supabase
          .from("users")
          .select("role")
          .eq("id", session.user.id)
          .single()

        if (userData?.role) {
          setRole(userData.role)
          localStorage.setItem('userRole', userData.role)
        } else {
          // Fallback: check user_metadata
          const metadataRole = session.user.user_metadata?.role
          setRole(metadataRole || "user")
          localStorage.setItem('userRole', metadataRole || "user")
        }
      } catch (error) {
        console.error("Error fetching user role:", error)
        setRole("user")
      } finally {
        setLoading(false)
      }
    }

    fetchRole()

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      fetchRole()
    })

    return () => subscription.unsubscribe()
  }, [])

  return {
    role,
    loading,
    isSubAgent: role === "sub_agent",
    isDealer: role === "dealer",
    isAdmin: role === "admin",
    isUser: role === "user"
  }
}
