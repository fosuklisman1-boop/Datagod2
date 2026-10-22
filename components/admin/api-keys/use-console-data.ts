"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createLatestGate } from "@/lib/api-v2/latest-gate"
import { toast } from "sonner"
import { mergeKeys, type ConsoleKey, type V1AdminKey, type V2AdminKey } from "@/lib/api-v2/admin-view"
import type { AdminStats, KeyActivity } from "@/lib/api-v2/admin-stats"
import type { LimitGroup } from "@/lib/api-v2/limits"
import { adminFetch } from "./admin-fetch"

export interface ApiConfig {
  enabled: boolean
  allowed_roles: string[]
}

export interface SourceErrors {
  v1: string | null
  v2: string | null
  stats: string | null
  config: string | null
}

const NO_ERRORS: SourceErrors = { v1: null, v2: null, stats: null, config: null }

/**
 * Loads v1 keys, v2 keys, stats and config in parallel. Each source degrades on its own:
 * a failing source records an error and keeps the rest of the console usable.
 */
export function useConsoleData(enabled: boolean) {
  const [v1, setV1] = useState<V1AdminKey[]>([])
  const [v2, setV2] = useState<V2AdminKey[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [config, setConfig] = useState<ApiConfig | null>(null)
  const [errors, setErrors] = useState<SourceErrors>(NO_ERRORS)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  // Last-started refresh wins: an older load that resolves late must not overwrite newer state.
  const gate = useRef(createLatestGate())
  const latest = useRef<Promise<void>>(Promise.resolve())

  const load = useCallback(async (): Promise<void> => {
    const ticket = gate.current.next()
    setLoading(true)
    const [r1, r2, rs, rc] = await Promise.all([
      adminFetch<{ keys?: V1AdminKey[] }>("/api/admin/api-keys"),
      adminFetch<{ keys?: V2AdminKey[] }>("/api/admin/api-v2/keys"),
      adminFetch<{ stats?: AdminStats }>("/api/admin/api-v2/stats"),
      adminFetch<ApiConfig>("/api/admin/api-v2/config"),
    ])
    // Superseded: wait for the newest load instead, so callers (and row busy flags) only
    // resume once the freshest state has been applied.
    if (!gate.current.isLatest(ticket)) return latest.current
    if (r1.ok) setV1(Array.isArray(r1.data?.keys) ? r1.data.keys : [])
    if (r2.ok) setV2(Array.isArray(r2.data?.keys) ? r2.data.keys : [])
    setStats(rs.ok && rs.data?.stats ? rs.data.stats : null)
    if (rc.ok && rc.data) setConfig({ enabled: rc.data.enabled === true, allowed_roles: rc.data.allowed_roles ?? [] })
    setErrors({
      v1: r1.ok ? null : r1.error,
      v2: r2.ok ? null : r2.error,
      stats: rs.ok ? null : rs.error,
      config: rc.ok ? null : rc.error,
    })
    setLoading(false)
  }, [])

  const refresh = useCallback((): Promise<void> => {
    const p = load()
    latest.current = p
    return p
  }, [load])

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  const keys: ConsoleKey[] = useMemo(() => mergeKeys(v1, v2), [v1, v2])

  /** Runs one mutation for a key with the key marked busy; returns true on success. */
  const run = useCallback(
    async (id: string, url: string, init: RequestInit, success: string): Promise<boolean> => {
      setBusy((b) => ({ ...b, [id]: true }))
      try {
        const r = await adminFetch(url, init)
        if (r.status === 409) {
          toast.error("Key changed, refreshed", { description: r.error ?? undefined })
          await refresh()
          return false
        }
        if (!r.ok) {
          toast.error(r.error ?? "Request failed")
          return false
        }
        toast.success(success)
        // Keep the row busy until the fresh status is loaded so a second click cannot act on stale state.
        await refresh()
        return true
      } finally {
        setBusy((b) => {
          const next = { ...b }
          delete next[id]
          return next
        })
      }
    },
    [refresh]
  )

  const patchV2 = (k: ConsoleKey, body: object, success: string) =>
    run(k.id, `/api/admin/api-v2/keys/${encodeURIComponent(k.id)}`, { method: "PATCH", body: JSON.stringify(body) }, success)

  const v1Url = (k: ConsoleKey) => `/api/admin/api-keys?id=${encodeURIComponent(k.id)}`

  const actions = {
    approve: (k: ConsoleKey) => patchV2(k, { action: "approve" }, "Key approved"),
    revoke: (k: ConsoleKey) => patchV2(k, { action: "revoke" }, "Key revoked"),
    saveLimits: (k: ConsoleKey, limits: Record<LimitGroup, number>) =>
      patchV2(k, { action: "set_limits", limits }, "Rate limits saved"),
    resetLimits: (k: ConsoleKey) => patchV2(k, { action: "reset_limits" }, "Rate limits reset to default"),
    v1Toggle: (k: ConsoleKey) =>
      run(
        k.id,
        v1Url(k),
        { method: "PATCH", body: JSON.stringify({ is_active: k.status !== "active" }) },
        k.status === "active" ? "Key disabled" : "Key enabled"
      ),
    v1Delete: (k: ConsoleKey) => run(k.id, v1Url(k), { method: "DELETE" }, "API key deleted permanently"),
    v1SetRate: (k: ConsoleKey, perMin: number) =>
      run(k.id, v1Url(k), { method: "PATCH", body: JSON.stringify({ rate_limit_per_min: perMin }) }, "Rate limit updated"),
  }

  const saveConfig = useCallback(
    async (next: ApiConfig): Promise<boolean> => {
      const r = await adminFetch<ApiConfig>("/api/admin/api-v2/config", { method: "PUT", body: JSON.stringify(next) })
      if (!r.ok || !r.data) {
        toast.error(r.error ?? "Failed to save settings")
        return false
      }
      setConfig({ enabled: r.data.enabled === true, allowed_roles: r.data.allowed_roles ?? [] })
      setErrors((e) => ({ ...e, config: null }))
      toast.success("Settings saved")
      return true
    },
    []
  )

  const globalKill = useCallback(async () => {
    const r = await adminFetch<{ message?: string }>("/api/admin/api-keys/global-kill", { method: "POST" })
    if (r.ok) toast.success(r.data?.message ?? "All API keys disabled", { duration: 8000 })
    else toast.error(r.error ?? "Global kill failed", { duration: 15000 })
    await refresh()
  }, [refresh])

  return { keys, stats, config, errors, loading, busy, refresh, saveConfig, globalKill, ...actions }
}

export type ConsoleData = ReturnType<typeof useConsoleData>

export async function loadActivity(keyId: string) {
  return adminFetch<{ activity?: KeyActivity }>(`/api/admin/api-v2/keys/${encodeURIComponent(keyId)}/activity`)
}
