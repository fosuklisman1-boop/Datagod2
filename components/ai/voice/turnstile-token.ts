"use client"

// One Turnstile token for a call start, minted on click with the same site key and script as the storefront forms.
// Rendered in "interaction-only" mode: invisible unless Cloudflare needs the visitor to do something.
// Returns undefined when Turnstile is off or not configured (the server then skips the check), or on timeout/error
// (the server answers fallback "bot", which the UI shows as a calm "keep chatting here").
export async function getCallTurnstileToken(timeoutMs = 20_000): Promise<string | undefined> {
  if (typeof window === "undefined") return undefined
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  if (!siteKey) return undefined
  try {
    const r = await fetch("/api/public/turnstile-status")
    const d = r.ok ? await r.json() : { enabled: true }
    if (d?.enabled === false) return undefined
  } catch {
    // Unknown: try for a token anyway.
  }
  if (!document.querySelector("script[src*='turnstile/v0/api.js']")) {
    const s = document.createElement("script")
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    s.async = true
    s.defer = true
    document.head.appendChild(s)
  }
  const deadline = Date.now() + timeoutMs
  while (!window.turnstile) {
    if (Date.now() > deadline) return undefined
    await new Promise((res) => setTimeout(res, 100))
  }
  const box = document.createElement("div")
  box.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:100"
  document.body.appendChild(box)
  let widgetId: string | undefined
  try {
    return await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), Math.max(1000, deadline - Date.now()))
      const done = (v: string | undefined) => {
        clearTimeout(timer)
        resolve(v)
      }
      widgetId = window.turnstile!.render(box, {
        sitekey: siteKey,
        appearance: "interaction-only",
        callback: (t: string) => done(t),
        "error-callback": () => done(undefined),
        "expired-callback": () => done(undefined),
      })
    })
  } finally {
    try {
      if (widgetId) window.turnstile?.remove(widgetId)
    } catch {
      // noop
    }
    box.remove()
  }
}
