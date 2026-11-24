"use client"

import { useCallback, useEffect, useState } from "react"
import type { ConsoleKey } from "@/lib/api-v2/admin-view"
import type { AdminStats } from "@/lib/api-v2/admin-stats"
import type { ApiConfig, RoleOption, SourceErrors } from "./use-console-data"
import { adminFetch } from "./admin-fetch"
import { OverviewTiles } from "./OverviewTiles"
import { FeatureControls } from "./FeatureControls"
import { StuckV2Panel } from "./StuckV2Panel"
import { TrendBarsView, type TrendPoint } from "./TrendBars"

export interface OverviewTabProps {
  keys: ConsoleKey[]
  stats: AdminStats | null
  config: ApiConfig | null
  roles: RoleOption[] | null
  errors: SourceErrors
  loading: boolean
  onRetry: () => void
  saveConfig: (next: ApiConfig) => Promise<boolean>
  globalKill: () => Promise<void>
}

export function OverviewTabView(p: OverviewTabProps & { trend: { points: TrendPoint[]; loading: boolean; error: string | null }; onTrendRetry: () => void }) {
  return (
    <div className="space-y-5">
      <OverviewTiles keys={p.keys} stats={p.stats} statsError={p.errors.stats} loading={p.loading} onRetry={p.onRetry} />
      <div className="grid gap-5 lg:grid-cols-2">
        <TrendBarsView points={p.trend.points} loading={p.trend.loading} error={p.trend.error} onRetry={p.onTrendRetry} />
        <StuckV2Panel />
      </div>
      <FeatureControls config={p.config} roles={p.roles} error={p.errors.config} onSave={p.saveConfig} onRetry={p.onRetry} onGlobalKill={p.globalKill} />
    </div>
  )
}

/** Overview tab: loads its own 30-day trend when opened; the other panels come from the console data. */
export function OverviewTab(p: OverviewTabProps) {
  const [trend, setTrend] = useState<{ points: TrendPoint[]; loading: boolean; error: string | null }>({ points: [], loading: true, error: null })
  const load = useCallback(async () => {
    setTrend((t) => ({ ...t, loading: true, error: null }))
    const r = await adminFetch<{ points?: TrendPoint[] }>("/api/admin/api-v2/trend?days=30")
    setTrend({ points: r.ok ? (r.data?.points ?? []) : [], loading: false, error: r.ok ? null : r.error })
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  return <OverviewTabView {...p} trend={trend} onTrendRetry={() => void load()} />
}
