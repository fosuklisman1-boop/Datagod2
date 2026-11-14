import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"
import { useAuth } from "./use-auth"
import { toast } from "sonner"

/**
 * Hook to check if current user is an admin
 * Admins are defined by role = "admin" in the users table only (never user_metadata)
 */
export function useIsAdmin() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (authLoading) return

    if (!user) {
      setIsAdmin(false)
      setLoading(false)
      return
    }

    setLoading(true)
    checkAdminStatus()
  }, [user?.id, authLoading])

  const checkAdminStatus = async () => {
    try {
      if (!user?.id) {
        setIsAdmin(false)
        setLoading(false)
        return
      }

      // users.role is the ONLY source of truth. user_metadata is user-writable
      // (signUp options.data / auth.updateUser), so it can never grant admin.
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

      setIsAdmin(userData?.role === "admin")
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

