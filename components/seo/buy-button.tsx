"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { supabase } from "@/lib/supabase"

/**
 * Buy CTA for the public data pages. Server render and first paint link to
 * signup; once a browser session is found it points at the data packages page.
 */
export function BuyButton({ label = "Buy now", className }: { label?: string; className?: string }) {
  const [href, setHref] = useState("/auth/signup")

  useEffect(() => {
    let cancelled = false
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!cancelled && data.session) setHref("/dashboard/data-packages")
      })
      .catch(() => {
        // no readable session: stay on the signup link
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Button asChild size="lg" className={className ?? "w-full gap-2 sm:w-auto"}>
      <Link href={href}>
        {label} <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </Button>
  )
}
