"use client"

// Session handoff for the mobile app's in-app WebView. The app opens
//   /auth/mobile-handoff#access_token=…&refresh_token=…&next=/dashboard/…
// Tokens travel in the URL FRAGMENT (never sent to the server or logged);
// this page sets the Supabase session client-side and forwards to `next`.
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"

export default function MobileHandoffPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const run = async () => {
      const params = new URLSearchParams(window.location.hash.slice(1))
      const access_token = params.get("access_token")
      const refresh_token = params.get("refresh_token")
      let next = params.get("next") || "/dashboard"
      // Only allow same-origin relative paths — no open redirects.
      if (!next.startsWith("/") || next.startsWith("//")) next = "/dashboard"

      // Clear the fragment immediately so tokens never linger in history.
      window.history.replaceState(null, "", window.location.pathname)

      if (!access_token || !refresh_token) {
        router.replace(`/auth/login?redirect=${encodeURIComponent(next)}`)
        return
      }

      const { error: err } = await supabase.auth.setSession({ access_token, refresh_token })
      if (err) {
        setError(err.message)
        router.replace(`/auth/login?redirect=${encodeURIComponent(next)}`)
        return
      }
      router.replace(next)
    }
    run()
  }, [router])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">
        {error ? "Sign-in failed — redirecting…" : "Signing you in…"}
      </p>
    </div>
  )
}
