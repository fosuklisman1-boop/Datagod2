import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "./use-auth"
import { Loader2 } from "lucide-react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"

/**
 * Hook to protect dashboard routes - redirects unauthenticated users to login
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

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  return { isAuthenticated: !!user, loading }
}
