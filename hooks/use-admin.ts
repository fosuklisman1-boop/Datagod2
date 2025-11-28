import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"
import { useAuth } from "./use-auth"
import { toast } from "sonner"

/**
 * Hook to check if current user is an admin
 * Admins are defined by having role = "admin" in user_metadata OR users table
 */
export function useIsAdmin() {
  const { user } = useAuth()
  const router = useRouter()
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      setIsAdmin(false)
      setLoading(false)
      return
    }

    checkAdminStatus()
  }, [user?.id, user?.user_metadata])

  const checkAdminStatus = async () => {
    try {
      if (!user?.id) {
        setIsAdmin(false)
        setLoading(false)
        return
      }

      console.log("[USE-ADMIN] Checking admin status for user:", user.email)
      console.log("[USE-ADMIN] user_metadata:", user.user_metadata)

      // First check: user_metadata role
      if (user.user_metadata?.role === "admin") {
        console.log("[USE-ADMIN] User is admin (from user_metadata)")
        setIsAdmin(true)
        setLoading(false)
        return
      }

      // Second check: Query users table for role
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("role")
        .eq("id", user.id)
        .single()

      if (userError) {
        console.log("[USE-ADMIN] Error fetching user from table:", userError)
        setIsAdmin(false)
        setLoading(false)
        return
      }

      const isAdminUser = userData?.role === "admin"
      console.log("[USE-ADMIN] User role from users table:", userData?.role, "Is Admin:", isAdminUser)
      setIsAdmin(isAdminUser)
    } catch (error) {
      console.error("[USE-ADMIN] Error:", error)
      setIsAdmin(false)
    } finally {
      setLoading(false)
    }
  }

  return { isAdmin, loading }
}

/**
 * Hook to protect admin routes - redirects non-admins
 */
export function useAdminProtected() {
  const router = useRouter()
  const { isAdmin, loading } = useIsAdmin()

  useEffect(() => {
    console.log("[ADMIN-PROTECTED] isAdmin:", isAdmin, "loading:", loading)
    
    // Only redirect if we've finished checking and user is not admin
    if (!loading && !isAdmin) {
      console.log("[ADMIN-PROTECTED] Non-admin attempting access, redirecting...")
      // Small delay to ensure UI updates before redirect
      const timer = setTimeout(() => {
        toast.error("Unauthorized access - Admin role not found")
        router.push("/dashboard")
      }, 500)
      
      return () => clearTimeout(timer)
    }
  }, [isAdmin, loading, router])

  return { isAdmin, loading }
}

