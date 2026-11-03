"use client"

import { useEffect } from "react"
import { isMainSiteHost } from "@/lib/seo/main-site-host"
import { buildFirstTouch, recordFirstTouch } from "@/lib/signup-source"

/**
 * Records the first main-site page a visitor lands on (see lib/signup-source.ts).
 * Mounted once in the root layout, so it runs on the full page load only (the
 * landing page), not on client-side navigations. Renders nothing; any storage
 * failure (private mode, blocked site data) simply means no attribution.
 */
export function FirstTouchCapture() {
  useEffect(() => {
    try {
      if (!isMainSiteHost(window.location.host)) return
      const now = new Date()
      const source = buildFirstTouch(new URL(window.location.href), document.referrer, now)
      if (source) recordFirstTouch(window.localStorage, source, now)
    } catch {
      // Attribution is best-effort only.
    }
  }, [])
  return null
}
