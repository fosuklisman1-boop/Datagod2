import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"
import { useAuth } from "./use-auth"
import { toast } from "sonner"

/**
 * Hook to check if current user is an admin
 * Admins are defined by having role = "admin" in user_metadata
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

      // Check if user has admin role in metadata
      const isAdminUser = user.user_metadata?.role === "admin"
      setIsAdmin(isAdminUser)

      console.log("[USE-ADMIN] User:", user.email, "Is Admin:", isAdminUser)
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
    if (!loading && !isAdmin) {
      console.log("[ADMIN-PROTECTED] Non-admin attempting access, redirecting...")
      toast.error("Unauthorized access")
      router.push("/dashboard")
    }
  }, [isAdmin, loading, router])

  return { isAdmin, loading }
}

