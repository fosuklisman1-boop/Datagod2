"use client"

import { useEffect, useState } from "react"
import { useUserRole } from "./use-user-role"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { supabase } from "@/lib/supabase"
import { pickFirstVisiblePath } from "@/lib/dashboard-nav-items"

export interface FirstVisiblePathResult {
  path: string | null
  loading: boolean
}

/**
 * Resolves the first sidebar page this signed-in user can actually reach on
 * the current domain — used by app/dashboard/page.tsx to redirect onward
 * when dashboard_home itself is hidden. Sources role (useUserRole) and the
 * dealer-active-subscription check independently of components/layout/
 * sidebar.tsx's own equivalent fetch, since this hook may run on a page
 * that never mounts the sidebar.
 */
export function useFirstVisiblePath(): FirstVisiblePathResult {
  const { role, loading: roleLoading } = useUserRole()
  const domainBranding = useDomainBranding()
  const [dealerHasSubscription, setDealerHasSubscription] = useState(false)
  const [subLoading, setSubLoading] = useState(true)

  useEffect(() => {
    if (roleLoading) return
    if (role !== "dealer") {
      setSubLoading(false)
      return
    }
    setSubLoading(true)
    setDealerHasSubscription(false)
    let cancelled = false
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) {
        if (!cancelled) setSubLoading(false)
        return
      }
      const { data: sub } = await supabase
        .from("user_subscriptions")
        .select("id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .maybeSingle()
      if (!cancelled) {
        setDealerHasSubscription(!!sub)
        setSubLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [role, roleLoading])

  const loading = roleLoading || subLoading
  const path = loading
    ? null
    : pickFirstVisiblePath(role, domainBranding.services, domainBranding.hiddenPages, dealerHasSubscription)

  return { path, loading }
}
