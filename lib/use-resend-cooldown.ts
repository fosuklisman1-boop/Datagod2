import { useCallback, useEffect, useState } from "react"

/**
 * Countdown gate for an OTP "Send / Resend" button, persisted across reloads.
 *
 *   const cd = useResendCooldown(phoneDigits)   // key by the normalized number
 *   // after a code is sent:        cd.start()        // default 60s
 *   // send/resend button:          disabled={cd.seconds > 0}
 *   //                              label = cd.seconds > 0 ? `Resend in ${cd.seconds}s` : "…"
 *   // when the phone is cleared:   cd.reset()
 *
 * The deadline is stored in localStorage under `otp_resend:<key>`, so reloading
 * or reopening the modal resumes the remaining time instead of resetting it —
 * closing the "refresh to dodge the wait" loophole. Keying by phone means a
 * different number starts fresh. Each decrement schedules the next via setTimeout;
 * at 0 no timer runs idle.
 */
export function useResendCooldown(key?: string): {
  seconds: number
  start: (s?: number) => void
  reset: () => void
} {
  const [seconds, setSeconds] = useState(0)
  const storeKey = key ? `otp_resend:${key}` : null

  // Resume the remaining time whenever the key changes (incl. first mount after
  // a reload, once the user re-enters the same number).
  useEffect(() => {
    if (!storeKey || typeof window === "undefined") { setSeconds(0); return }
    try {
      const until = parseInt(localStorage.getItem(storeKey) || "0", 10)
      const remaining = until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0
      setSeconds(remaining)
    } catch {
      setSeconds(0)
    }
  }, [storeKey])

  // Tick down.
  useEffect(() => {
    if (seconds <= 0) return
    const t = setTimeout(() => setSeconds((s) => Math.max(0, s - 1)), 1000)
    return () => clearTimeout(t)
  }, [seconds])

  const start = useCallback((s = 60) => {
    setSeconds(s)
    if (storeKey && typeof window !== "undefined") {
      try { localStorage.setItem(storeKey, String(Date.now() + s * 1000)) } catch { /* ignore */ }
    }
  }, [storeKey])

  const reset = useCallback(() => {
    setSeconds(0)
    if (storeKey && typeof window !== "undefined") {
      try { localStorage.removeItem(storeKey) } catch { /* ignore */ }
    }
  }, [storeKey])

  return { seconds, start, reset }
}
