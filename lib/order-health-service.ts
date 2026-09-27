//
// Real, computed data for two customer-facing dashboard widgets: "your latest
// completed order" and "network health" (uptime/avg-delivery per network).
//
// This is a financial app — every number here must trace back to real order
// rows. No fabricated percentages, no hardcoded "1-2 hours" estimates, no
// status claims for a network with zero data in the window.
//
// "Delivery time" is measured from when the order was actually pushed to a
// supplier/provider, not from when it was placed — the gap between placement
// and dispatch (queueing, payment processing, admin review) reflects our own
// internal overhead, not the supplier's performance. That dispatch moment is
// mtn_fulfillment_tracking.created_at (a fresh row is inserted there the
// instant an order is submitted to a provider — see lib/mtn-fulfillment.ts's
// saveMTNTracking and lib/non-mtn-fulfillment.ts's createNonMTNOrder, both of
// which write this table regardless of network). Orders with no tracking row
// (historical orders routed through CodeCraft, now fully retired) fall back
// to orders.created_at — there's nothing else to measure dispatch from for
// those.
//
// Caller owns the Supabase client (passed in, never created here), matching
// lib/network-stock-service.ts's convention — testable with a plain fake
// object, no @supabase/supabase-js mocking required.

import type { SupabaseClient } from "@supabase/supabase-js"
import { HOLD_STATUS } from "@/lib/mtn-hold"

export const HEALTH_NETWORKS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"] as const
export type HealthNetwork = (typeof HEALTH_NETWORKS)[number]

export interface LatestOrderSummary {
  network: string
  volumeGb: string
  recipientPhone: string
  createdAt: string
  completedAt: string | null
  durationMinutes: number | null
  avgNetworkDurationMinutes: number | null
  isNight: boolean
  hasHeldOrder: boolean
}

export interface NetworkHealthStat {
  network: HealthNetwork
  status: "optimal" | "degraded" | "down" | "no_data"
  uptimePercent: number | null
  avgDeliveryMinutes: number | null
  sampleSize: number
}

/**
 * Normalizes a raw orders.network value into one of HEALTH_NETWORKS, or null
 * if it doesn't belong to any of them. Ported verbatim (case-insensitivity
 * aside) from migrations/combined_orders_view.sql's CASE statement — that is
 * the authoritative mapping for this table's historically inconsistent
 * network spelling/casing. Plain "AT" (no iShare/BigTime qualifier) does NOT
 * map to either bucket — it's a distinct, ambiguous historical value, not a
 * BigTime default.
 */
function normalizeNetwork(raw: string | null | undefined): HealthNetwork | null {
  const n = (raw || "").toLowerCase().trim()
  if (n === "mtn") return "MTN"
  if (n === "telecel") return "Telecel"
  if (n === "at - ishare" || n === "ishare" || n === "at-ishare") return "AT - iShare"
  if (n === "at - bigtime" || n === "at-bigtime" || n === "bigtime") return "AT - BigTime"
  return null
}

function minutesBetween(startIso: string, endIso: string): number {
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000)
}

/** True when `iso`'s local Africa/Accra hour is in the night window (9pm-6am). */
function isNightTime(iso: string): boolean {
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "Africa/Accra" }).format(new Date(iso)),
    10
  )
  return hour >= 21 || hour < 6
}

// A tracking row in any of these statuses represents a dead/superseded
// attempt, not the real dispatch — e.g. a retry inserts a NEW row rather than
// updating the old one (mtn_fulfillment_tracking has no upsert-on-retry
// path), so an order can have several rows and only the live one should count.
const DEAD_TRACKING_STATUSES = new Set(["failed", "error", "abandoned"])

/**
 * Looks up, for each given orders.id, the timestamp it was actually pushed to
 * a supplier — mtn_fulfillment_tracking.created_at for the most recent
 * non-dead row on that order. Orders absent from the returned map have no
 * tracking row at all; callers should fall back to orders.created_at for
 * those (see module doc comment).
 */
async function getDispatchTimestamps(
  supabase: SupabaseClient,
  orderIds: string[]
): Promise<Map<string, string>> {
  if (orderIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("order_id, created_at, status")
    .eq("order_type", "bulk")
    .in("order_id", orderIds)
  if (error) throw error

  const map = new Map<string, string>()
  for (const row of (data ?? []) as { order_id: string; created_at: string; status: string }[]) {
    if (DEAD_TRACKING_STATUSES.has(row.status)) continue
    const existing = map.get(row.order_id)
    if (!existing || new Date(row.created_at).getTime() > new Date(existing).getTime()) {
      map.set(row.order_id, row.created_at)
    }
  }
  return map
}

function resolveStartTime(orderId: string, placedAt: string, dispatchMap: Map<string, string>): string {
  return dispatchMap.get(orderId) ?? placedAt
}

/**
 * The current user's own most recently completed order, with real (not
 * hardcoded) delivery-time context. Returns null when the user has no
 * completed orders yet — a normal state, not an error.
 */
export async function getLatestCompletedOrder(
  supabase: SupabaseClient,
  userId: string
): Promise<LatestOrderSummary | null> {
  const { data: latest, error } = await supabase
    .from("orders")
    .select("id, network, size, phone_number, created_at, updated_at")
    .eq("user_id", userId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!latest) return null

  const normalized = normalizeNetwork(latest.network) ?? latest.network

  const ownDispatchMap = await getDispatchTimestamps(supabase, [latest.id])
  const ownStartTime = resolveStartTime(latest.id, latest.created_at, ownDispatchMap)
  const durationMinutes = minutesBetween(ownStartTime, latest.updated_at)

  // Real, computed estimate: average dispatch->completed time for this same
  // network across the whole platform in the last 24h. A single-sample
  // average (just this order itself) isn't a meaningful estimate, so it's
  // omitted rather than shown.
  let avgNetworkDurationMinutes: number | null = null
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: networkOrders, error: networkError } = await supabase
    .from("orders")
    .select("id, created_at, updated_at")
    .eq("network", latest.network)
    .eq("status", "completed")
    .gte("created_at", dayAgo)
  if (networkError) throw networkError
  const networkRows = (networkOrders ?? []) as { id: string; created_at: string; updated_at: string }[]
  const networkDispatchMap = await getDispatchTimestamps(supabase, networkRows.map((o) => o.id))
  const durations = networkRows.map((o) =>
    minutesBetween(resolveStartTime(o.id, o.created_at, networkDispatchMap), o.updated_at)
  )
  if (durations.length > 1) {
    avgNetworkDurationMinutes = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
  }

  const { data: heldRow, error: heldError } = await supabase
    .from("orders")
    .select("id")
    .eq("user_id", userId)
    .eq("status", HOLD_STATUS)
    .limit(1)
    .maybeSingle()
  if (heldError) throw heldError

  return {
    network: normalized,
    volumeGb: String(latest.size ?? ""),
    recipientPhone: latest.phone_number ?? "",
    createdAt: latest.created_at,
    completedAt: latest.updated_at,
    durationMinutes,
    avgNetworkDurationMinutes,
    isNight: isNightTime(latest.created_at),
    hasHeldOrder: !!heldRow,
  }
}

const RESOLVED_STATUSES = new Set(["completed", "failed", "reversed"])

/**
 * Platform-wide per-network health over a rolling window. Each network's
 * uptime is computed from orders whose outcome has actually resolved
 * (completed/failed/reversed) — in-flight statuses (pending/processing/
 * held_registration/...) are excluded from both the numerator and
 * denominator, since they haven't finished yet. avgDeliveryMinutes measures
 * dispatch-to-completed (see module doc comment), computed only over the
 * completed subset. A network with zero resolved orders in the window gets
 * "no_data" with null stats, never a fabricated percentage.
 */
export async function getNetworkHealth(
  supabase: SupabaseClient,
  windowHours = 24
): Promise<NetworkHealthStat[]> {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const { data: rows, error } = await supabase
    .from("orders")
    .select("id, network, status, created_at, updated_at")
    .gte("created_at", windowStart)
    .limit(5000) // sane bound; if this table's volume ever outgrows client-side
    // aggregation, move this to a Postgres RPC/view instead of raw-row pulls.
  if (error) throw error

  const allRows = (rows ?? []) as { id: string; network: string; status: string; created_at: string; updated_at: string }[]
  const completedIds = allRows.filter((r) => r.status === "completed").map((r) => r.id)
  const dispatchMap = await getDispatchTimestamps(supabase, completedIds)

  const buckets = new Map<HealthNetwork, { completed: number; resolved: number; completedDurations: number[] }>()
  for (const network of HEALTH_NETWORKS) {
    buckets.set(network, { completed: 0, resolved: 0, completedDurations: [] })
  }

  for (const row of allRows) {
    const bucketKey = normalizeNetwork(row.network)
    if (!bucketKey) continue // doesn't belong to any tracked network — drop, don't force-fit
    if (!RESOLVED_STATUSES.has(row.status)) continue // in-flight — not yet resolved

    const bucket = buckets.get(bucketKey)!
    bucket.resolved++
    if (row.status === "completed") {
      bucket.completed++
      const startTime = resolveStartTime(row.id, row.created_at, dispatchMap)
      bucket.completedDurations.push(minutesBetween(startTime, row.updated_at))
    }
  }

  return HEALTH_NETWORKS.map((network) => {
    const bucket = buckets.get(network)!
    if (bucket.resolved === 0) {
      return { network, status: "no_data", uptimePercent: null, avgDeliveryMinutes: null, sampleSize: 0 }
    }
    const uptimePercent = Math.round((100 * bucket.completed) / bucket.resolved)
    const avgDeliveryMinutes =
      bucket.completedDurations.length > 0
        ? Math.round(bucket.completedDurations.reduce((a, b) => a + b, 0) / bucket.completedDurations.length)
        : null
    const status: NetworkHealthStat["status"] =
      uptimePercent >= 98 ? "optimal" : uptimePercent >= 90 ? "degraded" : "down"
    return { network, status, uptimePercent, avgDeliveryMinutes, sampleSize: bucket.resolved }
  })
}
