"use client"

import { useEffect, useRef, useState } from "react"
import { smsFetch } from "../../_lib/api"

export interface PolicyPreview {
  decision: string
  code: string
  reason: string
  flagged?: boolean
  unavailable?: boolean
}

/**
 * Advisory draft check: debounced (600 ms) POST /api/sms/compose/preview.
 * Out-of-order and stale responses are ignored. Never throws and never blocks sending.
 */
export function usePolicyPreview(message: string, senderId: string, recipientCount: number): PolicyPreview | null {
  const [preview, setPreview] = useState<PolicyPreview | null>(null)
  const seq = useRef(0)
  const count = Math.max(0, Math.min(5000, Math.floor(recipientCount)))

  useEffect(() => {
    const mine = ++seq.current
    if (message.trim().length === 0) { setPreview(null); return }
    const timer = setTimeout(async () => {
      const res = await smsFetch<PolicyPreview>("/api/sms/compose/preview", {
        method: "POST",
        body: JSON.stringify({ message, senderId: senderId || undefined, recipientCount: count }),
      })
      if (mine !== seq.current) return // a newer request superseded this one
      setPreview(res.ok && res.data && typeof res.data === "object" ? res.data : null)
    }, 600)
    return () => clearTimeout(timer)
  }, [message, senderId, count])

  return preview
}
