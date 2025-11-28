import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "./use-auth"

/**
 * Hook to protect dashboard routes - redirects unauthenticated users to login
 * This hook does NOT return JSX - components using this should handle their own loading/redirect UI
 */
export function useProtectedPage() {
  const router = useRouter()
  const { user, loading } = useAuth()

  useEffect(() => {
    if (!loading && !user) {
      console.log("[PROTECTED-PAGE] No user detected, redirecting to login")
      router.push("/auth/login")
    }
  }, [user, loading, router])

  return { isAuthenticated: !!user, loading }
}
