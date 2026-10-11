"use client"
import { useCallback, useEffect, useRef, useState } from "react"

/** Load data on mount and whenever `deps` change; ignores out-of-order responses and results after unmount. */
export function useLoad<T>(
  loader: () => Promise<{ success: boolean; data?: T; error?: string }>,
  deps: unknown[]
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const mounted = useRef(true)
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    let res: { success: boolean; data?: T; error?: string }
    try {
      res = await loaderRef.current()
    } catch (e) {
      res = { success: false, error: e instanceof Error ? e.message : "Could not load" }
    }
    if (!mounted.current || mine !== seq.current) return
    if (res.success && res.data !== undefined) { setData(res.data); setError(null) }
    else setError(res.error ?? "Could not load")
    setLoading(false)
  }, deps)

  useEffect(() => { void reload() }, [reload])
  return { data, error, loading, reload }
}
