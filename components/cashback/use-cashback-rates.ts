"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { NO_RATES, parseRates, ratesStale, type RatesResponse } from "@/lib/cashback/display"

/**
 * Cashback rates for the dashboard: fetched once on mount, and `ensureFresh()` re-fetches when older than
 * 5 minutes (call it before opening a pay/confirm step). Any failure means "no cashback" - the server decides.
 */
export function useCashbackRates() {
  const [rates, setRates] = useState<RatesResponse>(NO_RATES)
  const fetchedAtRef = useRef<number | null>(null)
  const inflightRef = useRef<Promise<RatesResponse> | null>(null)
  const ratesRef = useRef<RatesResponse>(NO_RATES)

  const load = useCallback((): Promise<RatesResponse> => {
    if (inflightRef.current) return inflightRef.current
    const p = (async () => {
      let next = NO_RATES
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session) {
          const res = await fetch("/api/cashback/rates", { headers: { Authorization: `Bearer ${session.access_token}` } })
          if (res.ok) next = parseRates(await res.json().catch(() => null))
        }
      } catch {
        next = NO_RATES
      }
      ratesRef.current = next
      fetchedAtRef.current = Date.now()
      setRates(next)
      return next
    })().finally(() => { inflightRef.current = null })
    inflightRef.current = p
    return p
  }, [])

  useEffect(() => { void load() }, [load])

  const ensureFresh = useCallback(async (): Promise<RatesResponse> => {
    if (ratesStale(fetchedAtRef.current, Date.now())) return load()
    return ratesRef.current
  }, [load])

  return { rates, ensureFresh }
}
