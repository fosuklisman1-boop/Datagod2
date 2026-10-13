"use client"

import { useEffect, useState } from "react"

export interface AvailabilityBiller {
  key: string
  label: string
  logo: string
  inputHint: string
  page: "bills" | "broadband"
  min: number
  max: number
}
export interface BillsAvailability { enabled: boolean; billers: AvailabilityBiller[] }

/** Public, unauthenticated. Any failure reads as "not available". null = still loading. */
export function useBillsAvailability(): BillsAvailability | null {
  const [a, setA] = useState<BillsAvailability | null>(null)
  useEffect(() => {
    let alive = true
    fetch("/api/bills/availability")
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!alive) return
        setA(j && j.enabled === true && Array.isArray(j.billers) ? j : { enabled: false, billers: [] })
      })
      .catch(() => { if (alive) setA({ enabled: false, billers: [] }) })
    return () => { alive = false }
  }, [])
  return a
}

export function featureAvailable(a: BillsAvailability | null, feature: "bills" | "broadband"): boolean {
  if (!a || !a.enabled) return false
  return a.billers.some(b => b.page === feature)
}
