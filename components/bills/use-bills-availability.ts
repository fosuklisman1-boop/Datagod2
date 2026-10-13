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

const NONE: BillsAvailability = { enabled: false, billers: [] }
let cached: Promise<BillsAvailability> | null = null

function load(): Promise<BillsAvailability> {
  return fetch("/api/bills/availability")
    .then(r => (r.ok ? r.json() : null))
    .then(j => (j && j.enabled === true && Array.isArray(j.billers) ? (j as BillsAvailability) : NONE))
    .catch(() => NONE)
}

/** Shared in-flight/settled promise so Sidebar and pages don't refetch on every mount. */
export function getBillsAvailability(refresh = false): Promise<BillsAvailability> {
  if (!cached || refresh) cached = load()
  return cached
}

/** Public, unauthenticated. Any failure reads as "not available". null = still loading. */
export function useBillsAvailability(): BillsAvailability | null {
  const [a, setA] = useState<BillsAvailability | null>(null)
  useEffect(() => {
    let alive = true
    getBillsAvailability().then(v => { if (alive) setA(v) })
    return () => { alive = false }
  }, [])
  return a
}

export function featureAvailable(a: BillsAvailability | null, feature: "bills" | "broadband"): boolean {
  if (!a || !a.enabled) return false
  return a.billers.some(b => b.page === feature)
}
