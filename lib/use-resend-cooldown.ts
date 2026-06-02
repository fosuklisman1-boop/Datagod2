import { useCallback, useEffect, useState } from "react"

/**
 * Countdown gate for an OTP "Resend" button.
 *
 *   const cd = useResendCooldown()
 *   // after a code is sent:        cd.start()        // default 60s
 *   // resend button:               disabled={cd.seconds > 0}
 *   //                              label = cd.seconds > 0 ? `Resend in ${cd.seconds}s` : "Resend"
 *   // when the phone is changed:   cd.reset()
 *
 * Each decrement schedules the next via setTimeout; at 0 the effect returns
 * early so no timer runs idle. Cleans up on unmount.
 */
export function useResendCooldown(): {
  seconds: number
  start: (s?: number) => void
  reset: () => void
} {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (seconds <= 0) return
    const t = setTimeout(() => setSeconds((s) => Math.max(0, s - 1)), 1000)
    return () => clearTimeout(t)
  }, [seconds])

  const start = useCallback((s = 60) => setSeconds(s), [])
  const reset = useCallback(() => setSeconds(0), [])

  return { seconds, start, reset }
}
