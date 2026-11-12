"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { cn } from "@/lib/utils"

/** "Support active now / away", polled every 45 seconds while the tab is visible. */
export function PresenceBadge() {
  const [active, setActive] = useState<boolean | null>(null)

  useEffect(() => {
    let stopped = false
    const poll = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const { data } = await supabase.auth.getSession()
        const token = data.session?.access_token
        if (!token) return
        const res = await fetch("/api/support/presence", { headers: { Authorization: `Bearer ${token}` } })
        const json = await res.json()
        if (!stopped && res.ok) setActive(Boolean(json?.data?.active))
      } catch {
        // Presence is cosmetic; leave the last known value.
      }
    }
    void poll()
    const timer = setInterval(poll, 45_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  if (active === null) return null
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-semibold text-foreground">
      <span className={cn("h-2 w-2 rounded-full", active ? "bg-success" : "bg-muted-foreground/50")} />
      {active ? "Support active now" : "Support away"}
    </span>
  )
}
