"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import type { StuckClaim, StuckOrder } from "@/lib/api-v2/stuck"
import { formatGhanaDate } from "@/lib/api-v1/retirement-ui"
import { adminFetch } from "./admin-fetch"
import { Eyebrow, IconChip, InlineError, Panel } from "./ui"

export interface StuckData {
  claims: StuckClaim[]
  orders: StuckOrder[]
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : formatGhanaDate(d)
}

/** Report-only list of v2 claims/orders stuck for over 10 minutes. */
export function StuckV2PanelView({ data, loading, error, onRefresh }: { data: StuckData | null; loading: boolean; error: string | null; onRefresh: () => void }) {
  const total = data ? data.claims.length + data.orders.length : 0
  return (
    <Panel className="space-y-4">
      <div className="flex items-start gap-3">
        <IconChip icon={AlertTriangle} tone={total > 0 ? "amber" : "primary"} />
        <div className="min-w-0 flex-1">
          <Eyebrow>API v2</Eyebrow>
          <h2 className="text-base font-bold text-foreground">Stuck v2 work</h2>
          <p className="text-sm text-muted-foreground">Claims and orders unfinished for over 10 minutes. Report only: nothing here is changed automatically.</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh stuck list"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} aria-hidden />
        </button>
      </div>

      {error && <InlineError message={`Stuck list could not be loaded: ${error}`} onRetry={onRefresh} />}
      {!error && data && total === 0 && <p className="text-sm text-muted-foreground">Nothing is stuck.</p>}

      {data && total > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground">Claims ({data.claims.length})</p>
            {data.claims.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border text-sm">
                {data.claims.map((c) => (
                  <li key={c.id} className="space-y-0.5 px-3 py-2">
                    <p className="font-medium text-foreground">
                      {c.kind} <span className="text-muted-foreground">({c.status})</span>
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {c.reference ?? c.id} · user {c.user_id} · since {when(c.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground">Orders ({data.orders.length})</p>
            {data.orders.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border text-sm">
                {data.orders.map((o) => (
                  <li key={o.id} className="space-y-0.5 px-3 py-2">
                    <p className="font-medium text-foreground">
                      {o.network ?? "Order"} <span className="text-muted-foreground">({o.status})</span>
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {o.api_reference ?? o.id} · user {o.user_id} · since {when(o.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}

export function StuckV2Panel() {
  const [data, setData] = useState<StuckData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await adminFetch<StuckData>("/api/admin/api-v2/stuck")
    if (r.ok && r.data) {
      setData({ claims: Array.isArray(r.data.claims) ? r.data.claims : [], orders: Array.isArray(r.data.orders) ? r.data.orders : [] })
      setError(null)
    } else setError(r.error)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return <StuckV2PanelView data={data} loading={loading} error={error} onRefresh={() => void load()} />
}
