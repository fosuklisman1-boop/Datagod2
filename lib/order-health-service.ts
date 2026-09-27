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
// to that order's own created_at — there's nothing else to measure dispatch
// from for those.
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
 * Normalizes a raw network value (as stored on any of the 5 order tables)
 * into one of HEALTH_NETWORKS, or null if it doesn't belong to any of them.
 * Ported (case-insensitivity aside) from combined_orders_view.sql's several
 * per-table CASE statements — the authoritative mapping for this app's
 * historically inconsistent network spelling/casing across tables. Plain
 * "AT" or bare "AirtelTigo" (no iShare/BigTime qualifier — the USSD tables'
 * own network menu treats "AirtelTigo" as a THIRD, distinct choice from
 * "AT-iShare") does NOT map to either AT bucket; it's dropped rather than
 * force-fit into iShare or BigTime.
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

type TrackingIdColumn = "order_id" | "shop_order_id" | "api_order_id"

/**
 * Looks up, for each given order id, the timestamp it was actually pushed to
 * a supplier — mtn_fulfillment_tracking.created_at for the most recent
 * non-dead row on that order. `orderType`/`idColumn` select which of the
 * table's three possible id columns and which order_type value to match
 * (saveMTNTracking uses a different id column per source table — see
 * lib/mtn-fulfillment.ts). Orders absent from the returned map have no
 * tracking row at all; callers should fall back to that order's own
 * created_at for those.
 */
async function getDispatchTimestamps(
  supabase: SupabaseClient,
  orderType: string,
  idColumn: TrackingIdColumn,
  orderIds: string[]
): Promise<Map<string, string>> {
  if (orderIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from("mtn_fulfillment_tracking")
    .select(`${idColumn}, created_at, status`)
    .eq("order_type", orderType)
    .in(idColumn, orderIds)
  if (error) throw error

  const map = new Map<string, string>()
  for (const row of (data ?? []) as Record<string, any>[]) {
    if (DEAD_TRACKING_STATUSES.has(row.status)) continue
    const orderId = row[idColumn] as string
    const existing = map.get(orderId)
    if (!existing || new Date(row.created_at).getTime() > new Date(existing).getTime()) {
      map.set(orderId, row.created_at)
    }
  }
  return map
}

function resolveStartTime(orderId: string, placedAt: string, dispatchMap: Map<string, string>): string {
  return dispatchMap.get(orderId) ?? placedAt
}

/**
 * The current user's own most recently completed order (dashboard/bulk
 * purchases only — the `orders` table), with real (not hardcoded)
 * delivery-time context. Returns null when the user has no completed orders
 * yet — a normal state, not an error.
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

  const ownDispatchMap = await getDispatchTimestamps(supabase, "bulk", "order_id", [latest.id])
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
  const networkDispatchMap = await getDispatchTimestamps(supabase, "bulk", "order_id", networkRows.map((o) => o.id))
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
 * Per-source-table config for the 5 tables real orders can land in (mirrors
 * migrations/combined_orders_view.sql, minus that view's UI-only fields).
 * Network Health is a platform-wide signal, not a single-channel one — a
 * customer buying MTN through the web dashboard and one buying AT-iShare
 * through a USSD shop are both real traffic this widget should reflect.
 */
interface OrderSourceConfig {
  table: string
  statusColumn: "status" | "order_status"
  /** Only rows whose payment_status equals this are real, attempted orders —
   *  matches combined_orders_view's own WHERE clause for these tables (an
   *  abandoned/unpaid checkout is not the supplier's failure to fulfill). */
  paymentStatusFilter?: string
  trackingOrderType: string
  trackingIdColumn: TrackingIdColumn
}

const ORDER_SOURCES: OrderSourceConfig[] = [
  { table: "orders", statusColumn: "status", trackingOrderType: "bulk", trackingIdColumn: "order_id" },
  { table: "api_orders", statusColumn: "status", trackingOrderType: "api", trackingIdColumn: "api_order_id" },
  { table: "shop_orders", statusColumn: "order_status", paymentStatusFilter: "completed", trackingOrderType: "shop", trackingIdColumn: "shop_order_id" },
  { table: "ussd_orders", statusColumn: "order_status", paymentStatusFilter: "completed", trackingOrderType: "ussd", trackingIdColumn: "order_id" },
  { table: "ussd_shop_orders", statusColumn: "order_status", paymentStatusFilter: "completed", trackingOrderType: "ussd_shop", trackingIdColumn: "order_id" },
]

interface NetworkBucket {
  completed: number
  resolved: number
  completedDurations: number[]
}

/**
 * Platform-wide per-network health over a rolling window, aggregated across
 * all 5 order tables (see ORDER_SOURCES) — not just the web dashboard's own
 * `orders` table. Restricting to one channel under-reports networks whose
 * volume skews toward USSD/shop traffic (AT-iShare, AT-BigTime), which is
 * exactly what caused those two rows to wrongly show "no data": there was
 * real recent traffic, just not through the one table originally queried.
 *
 * Uptime is computed from orders whose outcome has actually resolved
 * (completed/failed/reversed) — in-flight statuses (pending/processing/
 * held_registration/...) are excluded from both the numerator and
 * denominator, since they haven't finished yet. avgDeliveryMinutes measures
 * dispatch-to-completed (see module doc comment), computed only over the
 * completed subset, and only over rows that actually have both a start and
 * end timestamp (a row missing updated_at still counts toward uptime, just
 * not toward the average). A network with zero resolved orders in the window
 * gets "no_data" with null stats, never a fabricated percentage.
 */
export async function getNetworkHealth(
  supabase: SupabaseClient,
  windowHours = 24
): Promise<NetworkHealthStat[]> {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()

  const buckets = new Map<HealthNetwork, NetworkBucket>()
  for (const network of HEALTH_NETWORKS) {
    buckets.set(network, { completed: 0, resolved: 0, completedDurations: [] })
  }

  for (const source of ORDER_SOURCES) {
    const selectCols = source.paymentStatusFilter
      ? `id, network, ${source.statusColumn}, payment_status, created_at, updated_at`
      : `id, network, ${source.statusColumn}, created_at, updated_at`

    const { data, error } = await supabase
      .from(source.table)
      .select(selectCols)
      .gte("created_at", windowStart)
      .limit(5000) // sane per-table bound; if any of these tables ever outgrows
      // client-side aggregation, move this to a Postgres RPC/view instead.
    if (error) throw error

    const rows = (data ?? []) as Record<string, any>[]
    const eligible = source.paymentStatusFilter
      ? rows.filter((r) => r.payment_status === source.paymentStatusFilter)
      : rows

    const completedIds = eligible.filter((r) => r[source.statusColumn] === "completed").map((r) => r.id as string)
    const dispatchMap = await getDispatchTimestamps(supabase, source.trackingOrderType, source.trackingIdColumn, completedIds)

    for (const row of eligible) {
      const bucketKey = normalizeNetwork(row.network)
      if (!bucketKey) continue // doesn't belong to any tracked network — drop, don't force-fit
      const status = row[source.statusColumn]
      if (!RESOLVED_STATUSES.has(status)) continue // in-flight — not yet resolved

      const bucket = buckets.get(bucketKey)!
      bucket.resolved++
      if (status === "completed") {
        bucket.completed++
        if (row.updated_at) {
          const startTime = resolveStartTime(row.id, row.created_at, dispatchMap)
          bucket.completedDurations.push(minutesBetween(startTime, row.updated_at))
        }
      }
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
