"use client"
import { useCallback, useEffect, useRef, useState } from "react"

/** Load data on mount and whenever `deps` change; ignores out-of-order responses. */
export function useLoad<T>(
  loader: () => Promise<{ success: boolean; data?: T; error?: string }>,
  deps: unknown[]
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    const res = await loader()
    if (mine !== seq.current) return
    if (res.success && res.data !== undefined) { setData(res.data); setError(null) }
    else setError(res.error ?? "Could not load")
    setLoading(false)
  }, deps)

  useEffect(() => { void reload() }, [reload])
  return { data, error, loading, reload }
}
