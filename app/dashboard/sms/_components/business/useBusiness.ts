"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { smsFetch, type SmsMode } from "../../_lib/api"
import type { KycProfileView } from "../../_lib/view"

export interface BusinessProfile extends KycProfileView {
  id: string
  submitted_at: string | null
  reviewed_at: string | null
}

export interface SenderRow {
  id: string
  sender_id: string
  local_status: string
  rejection_reason?: string | null
  is_pool?: boolean | null
  created_at: string
}

interface BusinessData { mode: SmsMode; profile: BusinessProfile | null }

/** Loads the KYC profile, the caller's sender IDs and the shop name (for the phone preview + suggestions). */
export function useBusiness() {
  const [data, setData] = useState<BusinessData | null>(null)
  const [senders, setSenders] = useState<SenderRow[]>([])
  const [shopName, setShopName] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const seq = useRef(0)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const reload = useCallback(async () => {
    const mine = ++seq.current
    const [b, s, c] = await Promise.all([
      smsFetch<BusinessData>("/api/sms/business"),
      smsFetch<SenderRow[]>("/api/sms/sender-ids"),
      smsFetch<{ tokens?: { shop_name?: string } }>("/api/sms/context"),
    ])
    if (!alive.current || mine !== seq.current) return
    if (b.ok) { setData(b.data); setError(null) } else setError(b.error)
    if (s.ok && Array.isArray(s.data)) setSenders(s.data)
    if (c.ok) setShopName(c.data?.tokens?.shop_name ?? "")
    setLoading(false)
  }, [])

  useEffect(() => { void reload() }, [reload])

  /** Replace the profile with the server's latest copy (after save/upload/submit) without a full reload. */
  const setProfile = useCallback((profile: BusinessProfile) => {
    setData((d) => (d ? { ...d, profile } : d))
  }, [])

  return { data, senders, shopName, loading, error, reload, setProfile }
}
