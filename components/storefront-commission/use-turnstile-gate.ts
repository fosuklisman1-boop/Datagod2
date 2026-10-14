"use client"

import { useEffect, useState } from "react"

/** Turnstile state for a sheet: tokens are single-use, so `renew()` after every request remounts the widget. */
export function useTurnstileGate() {
  const [enabled, setEnabled] = useState(true)
  const [token, setToken] = useState("")
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    fetch("/api/public/turnstile-status")
      .then(r => (r.ok ? r.json() : { enabled: true }))
      .then(d => setEnabled(d.enabled !== false))
      .catch(() => setEnabled(true))
  }, [])

  return { enabled, token, nonce, setToken, renew: () => { setToken(""); setNonce(n => n + 1) } }
}
