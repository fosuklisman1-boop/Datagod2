"use client"

import { useEffect, useRef } from "react"

// Cloudflare Turnstile loader + render helper.
// One <script> tag is loaded globally; each widget mounts/unmounts via the JS API.

declare global {
  interface Window {
    turnstile?: {
      render: (selector: string | HTMLElement, opts: {
        sitekey: string
        callback?: (token: string) => void
        "error-callback"?: () => void
        "expired-callback"?: () => void
        theme?: "light" | "dark" | "auto"
        size?: "normal" | "compact" | "flexible"
        appearance?: "always" | "execute" | "interaction-only"
      }) => string
      remove: (widgetId: string) => void
      reset: (widgetId?: string) => void
    }
  }
}

let scriptInjected = false
function injectScript() {
  if (scriptInjected || typeof window === "undefined") return
  if (document.querySelector("script[src*='turnstile/v0/api.js']")) {
    scriptInjected = true
    return
  }
  const s = document.createElement("script")
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
  s.async = true
  s.defer = true
  document.head.appendChild(s)
  scriptInjected = true
}

export interface TurnstileWidgetHandle {
  reset: () => void
}

interface Props {
  onToken: (token: string) => void
  onExpire?: () => void
  onError?: () => void
  theme?: "light" | "dark" | "auto"
  className?: string
}

export default function TurnstileWidget({ onToken, onExpire, onError, theme = "auto", className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

  useEffect(() => {
    injectScript()

    let cancelled = false
    const tryRender = () => {
      if (cancelled) return
      if (!window.turnstile) {
        setTimeout(tryRender, 100)
        return
      }
      if (!containerRef.current || !siteKey) return
      if (widgetIdRef.current) return // already rendered

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme,
        callback: (token: string) => onToken(token),
        "expired-callback": () => onExpire?.(),
        "error-callback": () => onError?.(),
      })
    }
    tryRender()

    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current) } catch { /* noop */ }
        widgetIdRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, theme])

  if (!siteKey) {
    // Render nothing if not configured — server-side check will still fail-closed.
    return null
  }

  return <div ref={containerRef} className={className} />
}
