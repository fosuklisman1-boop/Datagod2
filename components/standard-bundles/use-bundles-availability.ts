"use client"

import { useEffect, useState } from "react"

export interface BundlesAvailability {
  enabled: boolean
  networks: { network: "MTN" | "TELECEL" | "AT"; label: string }[]
}

const NONE: BundlesAvailability = { enabled: false, networks: [] }
let cached: Promise<BundlesAvailability> | null = null

function load(): Promise<BundlesAvailability> {
  return fetch("/api/standard-bundles/availability")
    .then(r => (r.ok ? r.json() : null))
    .then(j => (j && j.enabled === true && Array.isArray(j.networks) && j.networks.length > 0 ? (j as BundlesAvailability) : NONE))
    .catch(() => NONE)
}

/** Shared in-flight/settled promise so the sidebar and page don't refetch on every mount. */
export function getBundlesAvailability(refresh = false): Promise<BundlesAvailability> {
  if (!cached || refresh) cached = load()
  return cached
}

/** Public, unauthenticated. Any failure reads as "not available". null = still loading. */
export function useBundlesAvailability(): BundlesAvailability | null {
  const [a, setA] = useState<BundlesAvailability | null>(null)
  useEffect(() => {
    let alive = true
    getBundlesAvailability().then(v => { if (alive) setA(v) })
    return () => { alive = false }
  }, [])
  return a
}
