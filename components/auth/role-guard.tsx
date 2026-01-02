"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useUserRole } from "@/hooks/use-user-role"
import { Loader2 } from "lucide-react"

interface SubAgentGuardProps {
  children: React.ReactNode
  // List of roles that are allowed to access the page
  allowedRoles?: string[]
  // Custom redirect path (defaults to /dashboard/shop-dashboard)
  redirectTo?: string
}

/**
 * A route guard component that restricts access based on user role.
 * By default, restricts sub-agents from accessing the page.
 */
export function RoleGuard({ 
  children, 
  allowedRoles = ["user", "admin"],
  redirectTo = "/dashboard/shop-dashboard"
}: SubAgentGuardProps) {
  const { role, loading } = useUserRole()
  const router = useRouter()

  useEffect(() => {
    if (!loading && role && !allowedRoles.includes(role)) {
      router.replace(redirectTo)
    }
  }, [role, loading, allowedRoles, redirectTo, router])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    )
  }

  if (!role || !allowedRoles.includes(role)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    )
  }

  return <>{children}</>
}

/**
 * Guard that only allows sub-agents to access the page
 */
export function SubAgentOnly({ children }: { children: React.ReactNode }) {
  return (
    <RoleGuard 
      allowedRoles={["sub_agent"]} 
      redirectTo="/dashboard"
    >
      {children}
    </RoleGuard>
  )
}

/**
 * Guard that blocks sub-agents from accessing the page
 */
export function NoSubAgents({ children }: { children: React.ReactNode }) {
  return (
    <RoleGuard 
      allowedRoles={["user", "admin"]} 
      redirectTo="/dashboard/shop-dashboard"
    >
      {children}
    </RoleGuard>
  )
}
