"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"

declare global {
  interface Window {
    __dgGaSync?: (pathname: string) => void
  }
}

/**
 * Keeps Google Analytics off private pages across client-side navigations (see
 * lib/analytics/google-analytics.ts). Mounted only when the tag itself is
 * rendered. Renders nothing.
 */
export function GoogleAnalyticsGuard() {
  const pathname = usePathname()
  useEffect(() => {
    window.__dgGaSync?.(pathname)
  }, [pathname])
  return null
}
