"use client"

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Activity, CheckCircle2, Clock, RefreshCw, Timer } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { formatDuration, shownDeliveredAt, tick, type ChannelEstimate, type StrengthTier } from "@/lib/delivery-estimate/compute"
import type { ChannelEstimateRow, DeliveryChannel } from "@/lib/delivery-estimate/query"
// Kept in step with ESTIMATE_API_VERSION in lib/delivery-estimate/query.ts (not imported: that module is server code).
const ESTIMATE_API_VERSION = 2

// Live delivery estimate widgets (lib/delivery-estimate). One fetch feeds both cards: the headline card for
// the main network and the per-channel strength list. Numbers come from two real reference orders, never
// an average; the open order's wait ticks every second between fetches.

const POLL_MS = 25_000
const COOLDOWN_S = 10

const BADGE: Record<DeliveryChannel, { text: string; className: string }> = {
  mtn: { text: "MTN", className: "bg-mtn text-mtn-foreground" },
  telecel: { text: "TEL", className: "bg-telecel text-telecel-foreground" },
  at_ishare: { text: "iS", className: "bg-at text-at-foreground" },
  at_bigtime: { text: "BT", className: "bg-violet-600 text-white" },
  utility: { text: "UB", className: "bg-sky-600 text-white" },
  standard: { text: "SB", className: "bg-emerald-600 text-white" },
}

const TIER_COLOR: Record<StrengthTier, string> = { Excellent: "#22c55e", Good: "#84cc16", Delayed: "#f59e0b", Critical: "#ef4444" }

function timeOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

/**
 * Keeps a widget failure inside the widget: a bad row or an unexpected error here must never take down the
 * dashboard, landing page or storefront around it. Renders nothing on error.
 */
export class WidgetBoundary extends Component<{ children: ReactNode; name: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { console.error(`[${this.props.name}] widget error (hidden):`, error) }
  render() { return this.state.failed ? null : this.props.children }
}

/**
 * Fetch + poll (paused while hidden) + a 1s tick for open orders + a manual refresh with cooldown.
 * `public: true` (landing page, storefronts) reads the no-login endpoint instead of the signed-in one.
 */
export function useDeliveryEstimates({ public: isPublic = false }: { public?: boolean } = {}) {
  const [rows, setRows] = useState<ChannelEstimateRow[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [, setTicks] = useState(0)
  // Server clock minus browser clock, so open orders tick against the server's time.
  const skew = useRef(0)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      let res: Response
      if (isPublic) {
        res = await fetch(`/api/public/delivery-estimate?v=${ESTIMATE_API_VERSION}`)
      } else {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.access_token) return
        res = await fetch(`/api/dashboard/delivery-estimate?v=${ESTIMATE_API_VERSION}`, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" })
      }
      const d = res.ok ? await res.json() : null
      if (d?.success) {
        // The public response may come from a shared cache, so its serverNow can be seconds old: trust the
        // browser clock there rather than skewing the live wait backwards.
        if (!isPublic) skew.current = Date.parse(d.serverNow) - Date.now()
        setRows(d.channels)
      } else setRows(prev => prev ?? [])
    } catch {
      setRows(prev => prev ?? []) // keep the last good numbers; the cards show their own empty state
    } finally {
      inFlight.current = false
    }
  }, [isPublic])

  useEffect(() => {
    void load()
    const poll = setInterval(() => { if (document.visibilityState === "visible") void load() }, POLL_MS)
    const onVisible = () => { if (document.visibilityState === "visible") void load() }
    document.addEventListener("visibilitychange", onVisible)
    const clock = setInterval(() => { if (document.visibilityState === "visible") setTicks(t => t + 1) }, 1000)
    return () => { clearInterval(poll); clearInterval(clock); document.removeEventListener("visibilitychange", onVisible) }
  }, [load])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  // Spins only for the real fetch, then a short visible cooldown so it can't be spammed.
  const refresh = useCallback(async () => {
    if (refreshing || cooldown > 0) return
    setRefreshing(true)
    try { await load() } finally { setRefreshing(false); setCooldown(COOLDOWN_S) }
  }, [cooldown, load, refreshing])

  const now = new Date(Date.now() + (Number.isFinite(skew.current) ? skew.current : 0)).toISOString()
  const live = rows?.map(r => {
    try { return { ...r, ...tick(r, now) } } catch { return r } // a row that can't tick keeps its fetched numbers
  }) ?? null
  return { rows: live, loading: rows === null, refreshing, cooldown, refresh }
}

function RefreshButton({ refreshing, cooldown, onClick, tone }: { refreshing: boolean; cooldown: number; onClick: () => void; tone: string }) {
  const disabled = refreshing || cooldown > 0
  return (
    <button
      type="button"
      aria-label={cooldown > 0 ? `Refresh available in ${cooldown} seconds` : "Refresh"}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-[11px] font-bold hover:bg-black/5 disabled:cursor-not-allowed ${tone}`}
    >
      <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""} ${cooldown > 0 ? "opacity-40" : ""}`} />
      {cooldown > 0 && <span className="tabular-nums opacity-70">{cooldown}s</span>}
    </button>
  )
}

const Bone = ({ className }: { className: string }) => <div className={`animate-pulse rounded-md bg-black/10 ${className}`} />

/** Headline card for one channel (the dashboard shows MTN): headline, live estimate, last order took. */
export function DeliveryHeadlineCard({ row, loading, refreshing, cooldown, onRefresh }: {
  row: ChannelEstimateRow | null; loading: boolean; refreshing: boolean; cooldown: number; onRefresh: () => void
}) {
  const title = row ? `${row.label} Delivery` : "Delivery"
  return (
    <div className="rounded-2xl border border-[#a5dccb] bg-[#eaf5f4] p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0f7a4d] text-white">
            <Timer className="h-5 w-5" />
          </span>
          <span className="truncate text-[15px] font-bold text-[#1e2537]">{title}</span>
        </div>
        <RefreshButton refreshing={refreshing} cooldown={cooldown} onClick={onRefresh} tone="text-[#0f7a4d]" />
      </div>

      {loading ? (
        <div className="mt-3 space-y-3" aria-busy="true" aria-label="Loading delivery estimate">
          <Bone className="h-6 w-48" />
          <div className="grid grid-cols-2 gap-2">
            <Bone className="h-16" />
            <Bone className="h-16" />
          </div>
          <Bone className="h-4 w-56" />
        </div>
      ) : !row || row.state === "no_data" || row.state === "no_recent" ? (
        <div className="py-6 text-center text-sm text-[#4b5563]">No recent orders</div>
      ) : (
        <HeadlineBody e={row} />
      )}
    </div>
  )
}

function HeadlineBody({ e }: { e: ChannelEstimate }) {
  const down = e.state === "down"
  return (
    <div className="mt-3 space-y-3">
      {down ? (
        <div className="text-lg font-extrabold text-[#7d5a00]">
          Experiencing delays
          {e.override?.reason && <p className="mt-0.5 text-xs font-medium text-[#7d5a00]">{e.override.reason}</p>}
        </div>
      ) : e.headline ? (
        <div className="flex items-center gap-2 text-lg font-extrabold text-[#0f7a4d]">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#22c55e] opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
          </span>
          {e.headline.text}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-white p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#6b7280]">Current estimate</p>
          <p className="mt-0.5 text-xl font-extrabold tabular-nums text-[#1e2537]">
            {e.currentSeconds !== null ? formatDuration(e.currentSeconds) : "—"}
          </p>
        </div>
        <div className="rounded-xl bg-white/70 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#6b7280]">Last order took</p>
          <p className="mt-0.5 text-xl font-extrabold tabular-nums text-[#1e2537]">
            {e.lastOrderSeconds !== null ? formatDuration(e.lastOrderSeconds) : "—"}
          </p>
        </div>
      </div>

      {e.lastOrder && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#3f4b56]">
          <Clock className="h-3.5 w-3.5" />
          <span>Placed: {timeOf(e.lastOrder.createdAt)}</span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-[#0f7a4d]" /> Delivered: {timeOf(shownDeliveredAt(e) ?? e.lastOrder.completedAt)}
          </span>
        </div>
      )}
    </div>
  )
}

/** Per-channel strength list (all data networks + utility bills). */
export function GatewayStrengthCard({ rows, loading, refreshing, cooldown, onRefresh }: {
  rows: ChannelEstimateRow[] | null; loading: boolean; refreshing: boolean; cooldown: number; onRefresh: () => void
}) {
  const live = (rows ?? []).filter(r => r.state === "live")
  const strong = live.filter(r => r.strength && (r.strength.tier === "Excellent" || r.strength.tier === "Good")).length
  const summary = loading ? "Checking…" : live.length === 0 ? "No recent orders" : strong === live.length ? "All Gateways Optimal" : `${strong}/${live.length} Gateways Optimal`
  return (
    <div className="rounded-2xl border border-[#e5e9f5] bg-white p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#e7f7ef] text-[#0f7a4d]">
            <Activity className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-bold text-[#1e2537]">Gateway Status</p>
            <p className="text-xs font-medium text-[#0f7a4d]">{summary} &middot; Live</p>
          </div>
        </div>
        <RefreshButton refreshing={refreshing} cooldown={cooldown} onClick={onRefresh} tone="text-[#1e2537]" />
      </div>

      <div className="mt-3 space-y-3">
        {loading
          ? [0, 1, 2, 3, 4].map(i => (
              <div key={i} className="rounded-xl bg-[#eef2ff] p-3.5" aria-hidden="true">
                <div className="flex items-center gap-2"><Bone className="h-8 w-8 rounded-full" /><Bone className="h-4 w-32" /></div>
                <Bone className="mt-3 h-1.5 w-full" />
                <Bone className="mt-2 h-3 w-40" />
              </div>
            ))
          : (rows ?? []).map(r => <StrengthRow key={r.channel} r={r} />)}
      </div>
    </div>
  )
}

function StrengthRow({ r }: { r: ChannelEstimateRow }) {
  // A channel this build doesn't know yet (e.g. the server added one after this page loaded) still gets a
  // neutral badge: a missing entry here used to crash the whole page.
  const badge = BADGE[r.channel] ?? { text: (r.label || "?").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "?", className: "bg-slate-500 text-white" }
  const head = (
    <div className="flex items-center gap-2">
      <span className={`flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-extrabold ${badge.className}`}>{badge.text}</span>
      <span className="text-sm font-bold text-[#1e2537]">{r.label}</span>
    </div>
  )
  if (r.state === "no_data" || r.state === "no_recent" || !r.strength) {
    return (
      <div className="rounded-xl bg-[#eef2ff] p-3.5">
        {head}
        <p className="mt-2 text-[11px] text-[#6b7280]">No recent orders</p>
      </div>
    )
  }
  const down = r.state === "down"
  const color = down ? "#9ca3af" : TIER_COLOR[r.strength.tier]
  return (
    <div className="rounded-xl bg-[#eef2ff] p-3.5">
      <div className="flex items-center justify-between">
        {head}
        <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold tabular-nums text-[#1e2537]">{r.strength.percent}%</span>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${r.strength.percent}%`, backgroundColor: color }} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[#4b5563]">
        <span>
          {down ? <span className="font-bold text-[#7d5a00]">Experiencing delays</span> : <span className="font-bold" style={{ color }}>{r.strength.tier}</span>}
        </span>
        {r.lastOrderSeconds !== null && <span>Last delivery took {formatDuration(r.lastOrderSeconds)}</span>}
      </div>
    </div>
  )
}

/**
 * Landing page / storefront version: the same two cards, fed by the no-login endpoint. `channels` limits the
 * strength list to what this page sells (e.g. a storefront without bills hides Utility Bills).
 */
export function PublicDeliveryStatus(props: { channels?: DeliveryChannel[]; className?: string }) {
  return <WidgetBoundary name="delivery-estimate"><PublicDeliveryStatusInner {...props} /></WidgetBoundary>
}

function PublicDeliveryStatusInner({ channels, className = "" }: { channels?: DeliveryChannel[]; className?: string }) {
  const d = useDeliveryEstimates({ public: true })
  const rows = d.rows && channels ? d.rows.filter(r => channels.includes(r.channel)) : d.rows
  const headline = rows?.find(r => r.channel === "mtn") ?? rows?.[0] ?? null
  return (
    <div className={`grid gap-4 md:grid-cols-2 ${className}`}>
      <DeliveryHeadlineCard row={headline} loading={d.loading} refreshing={d.refreshing} cooldown={d.cooldown} onRefresh={d.refresh} />
      <GatewayStrengthCard rows={rows} loading={d.loading} refreshing={d.refreshing} cooldown={d.cooldown} onRefresh={d.refresh} />
    </div>
  )
}

/** Dashboard version: MTN headline card + Gateway Status, signed-in endpoint, isolated by WidgetBoundary. */
export function DashboardDeliveryStatus() {
  return <WidgetBoundary name="delivery-estimate"><DashboardDeliveryStatusInner /></WidgetBoundary>
}

function DashboardDeliveryStatusInner() {
  const d = useDeliveryEstimates()
  return (
    <>
      <DeliveryHeadlineCard row={d.rows?.find(r => r.channel === "mtn") ?? null} loading={d.loading} refreshing={d.refreshing} cooldown={d.cooldown} onRefresh={d.refresh} />
      <GatewayStrengthCard rows={d.rows} loading={d.loading} refreshing={d.refreshing} cooldown={d.cooldown} onRefresh={d.refresh} />
    </>
  )
}
