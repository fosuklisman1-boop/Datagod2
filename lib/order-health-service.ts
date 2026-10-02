//
// Real, computed data for two customer-facing dashboard widgets: the
// platform's latest completed MTN order and "network health" (uptime/
// avg-delivery per network). Both are platform-wide signals, not scoped to
// the viewing account — deliberately: an individual dealer may go hours
// between their own completed orders, which made the "latest order" card
// look stale/wrong even though the platform itself was actively fulfilling
// other customers' orders the whole time. The latest-order card is pinned to
// MTN specifically (not "whichever network happened to complete last") —
// showing a different network on every refresh, purely because that
// network's last order happened to land a few minutes later, was confusing
// rather than reassuring. Personally-identifying fields (the recipient
// phone) are masked before leaving this module, since this data is now shown
// to every logged-in dashboard viewer, not just the order's own buyer.
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
import { maskPhone } from "@/lib/security-log"

export const HEALTH_NETWORKS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"] as const
export type HealthNetwork = (typeof HEALTH_NETWORKS)[number]

export interface LatestOrderSummary {
  network: string
  volumeGb: string
  /** Masked (see maskPhone) — this order may belong to any customer. */
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
export function normalizeNetwork(raw: string | null | undefined): HealthNetwork | null {
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

const RESOLVED_STATUSES = new Set(["completed", "failed", "reversed"])

/**
 * Per-source-table config for the 5 tables real orders can land in (mirrors
 * migrations/combined_orders_view.sql, minus that view's UI-only fields).
 * Network Health (and the network-wide average shown on the Latest Order
 * card) is a platform-wide signal, not a single-channel one — a customer
 * buying MTN through the web dashboard and one buying AT-iShare through a
 * USSD shop are both real traffic these should reflect.
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
  /** Column names differ per table (combined_orders_view.sql is the reference
   *  mapping) — needed only by getLatestCompletedOrder, which surfaces these
   *  two fields; fetchResolvedOrderRows/getNetworkHealth never select them. */
  sizeCol: string
  phoneCol: string
}

const ORDER_SOURCES: OrderSourceConfig[] = [
  { table: "orders", statusColumn: "status", trackingOrderType: "bulk", trackingIdColumn: "order_id", sizeCol: "size", phoneCol: "phone_number" },
  { table: "api_orders", statusColumn: "status", trackingOrderType: "api", trackingIdColumn: "api_order_id", sizeCol: "volume_gb", phoneCol: "recipient_phone" },
  { table: "shop_orders", statusColumn: "order_status", paymentStatusFilter: "completed", trackingOrderType: "shop", trackingIdColumn: "shop_order_id", sizeCol: "volume_gb", phoneCol: "customer_phone" },
  { table: "ussd_orders", statusColumn: "order_status", paymentStatusFilter: "completed", trackingOrderType: "ussd", trackingIdColumn: "order_id", sizeCol: "package_size", phoneCol: "recipient_phone" },
  { table: "ussd_shop_orders", statusColumn: "order_status", paymentStatusFilter: "completed", trackingOrderType: "ussd_shop", trackingIdColumn: "order_id", sizeCol: "package_size", phoneCol: "recipient_phone" },
]

interface ResolvedOrderRow {
  network: HealthNetwork
  status: "completed" | "failed" | "reversed"
  /** Dispatch->completed minutes; only set for a "completed" row that has an
   *  end timestamp. Null for failed/reversed rows (no successful delivery to
   *  time) or a completed row missing updated_at. */
  durationMinutes: number | null
}

/**
 * Fetches every resolved (completed/failed/reversed) order across all 5
 * order tables in the last `windowHours`, normalized to one flat shape.
 * Shared by getNetworkHealth (buckets by all 4 networks at once) and
 * computeNetworkAverageDuration (filters to one named network) so the
 * per-table fetch/filter/dispatch-lookup logic exists in exactly one place.
 */
async function fetchResolvedOrderRows(supabase: SupabaseClient, windowHours: number): Promise<ResolvedOrderRow[]> {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const results: ResolvedOrderRow[] = []

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
      const network = normalizeNetwork(row.network)
      if (!network) continue // doesn't belong to any tracked network — drop, don't force-fit
      const status = row[source.statusColumn] as string
      if (!RESOLVED_STATUSES.has(status)) continue // in-flight — not yet resolved

      let durationMinutes: number | null = null
      if (status === "completed" && row.updated_at) {
        const startTime = resolveStartTime(row.id, row.created_at, dispatchMap)
        durationMinutes = minutesBetween(startTime, row.updated_at)
      }
      results.push({ network, status: status as ResolvedOrderRow["status"], durationMinutes })
    }
  }

  return results
}

/**
 * Average completed-order delivery time (dispatch->completed) for one
 * network across all 5 order tables, platform-wide — matches
 * getNetworkHealth's own aggregation scope. Returns null for fewer than 2
 * samples — a single data point isn't a meaningful estimate.
 */
async function computeNetworkAverageDuration(
  supabase: SupabaseClient,
  network: HealthNetwork,
  windowHours: number
): Promise<number | null> {
  const rows = await fetchResolvedOrderRows(supabase, windowHours)
  const durations = rows
    .filter((r) => r.network === network && r.status === "completed" && r.durationMinutes !== null)
    .map((r) => r.durationMinutes as number)
  if (durations.length <= 1) return null
  return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
}

/**
 * The platform's single most recently completed MTN order — across all 5
 * order tables, regardless of which account (if any) placed it — with real
 * (not hardcoded) delivery-time context. Pinned to MTN specifically: this is
 * platform-wide (not scoped to the viewing account — a dashboard viewer's own
 * purchase history can go hours between completions while the platform is
 * actively fulfilling other customers' orders the whole time), but NOT
 * cross-network — showing whichever of the 4 tracked networks happened to
 * complete an order last made the card flip networks on every refresh for no
 * meaningful reason. Returns null only when there are no completed MTN orders
 * anywhere yet.
 */
export async function getLatestCompletedMtnOrder(
  supabase: SupabaseClient
): Promise<LatestOrderSummary | null> {
  const candidates = await Promise.all(
    ORDER_SOURCES.map(async (source) => {
      const selectCols = source.paymentStatusFilter
        ? `id, network, payment_status, ${source.sizeCol}, ${source.phoneCol}, created_at, updated_at`
        : `id, network, ${source.sizeCol}, ${source.phoneCol}, created_at, updated_at`

      let query: any = supabase
        .from(source.table)
        .select(selectCols)
        .eq(source.statusColumn, "completed")
        .ilike("network", "mtn") // case-insensitive — matches combined_orders_view.sql's LOWER(network) = 'mtn'
      if (source.paymentStatusFilter) query = query.eq("payment_status", source.paymentStatusFilter)

      const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle()
      if (error) throw error
      if (!data) return null
      const row = data as Record<string, any>
      return {
        source,
        id: row.id as string,
        network: row.network as string,
        volumeGb: row[source.sizeCol] != null ? String(row[source.sizeCol]) : "",
        phone: (row[source.phoneCol] as string) ?? "",
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
      }
    })
  )

  const found = candidates.filter((c): c is NonNullable<(typeof candidates)[number]> => c !== null)
  if (found.length === 0) return null
  found.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const latest = found[0]

  const normalized = normalizeNetwork(latest.network) ?? latest.network

  const ownDispatchMap = await getDispatchTimestamps(supabase, latest.source.trackingOrderType, latest.source.trackingIdColumn, [latest.id])
  const ownStartTime = resolveStartTime(latest.id, latest.createdAt, ownDispatchMap)
  const durationMinutes = minutesBetween(ownStartTime, latest.updatedAt)

  // Real, computed estimate: average dispatch->completed time for MTN across
  // the whole platform in the last 24h — matches getNetworkHealth's own
  // aggregation scope, so this card and the Network Health widget never
  // disagree about MTN's average. Null when there's fewer than 2 samples.
  const normalizedForAvg = normalizeNetwork(latest.network)
  const avgNetworkDurationMinutes = normalizedForAvg
    ? await computeNetworkAverageDuration(supabase, normalizedForAvg, 24)
    : null

  // Platform-wide: is ANY order (any table, any customer) currently sitting
  // in an MTN number-validation hold? Shown as a general "deliveries may be
  // delayed" notice, not a claim about the specific order above.
  const heldRows = await Promise.all(
    ORDER_SOURCES.map((source) =>
      supabase.from(source.table).select("id").eq(source.statusColumn, HOLD_STATUS).limit(1).maybeSingle()
    )
  )
  const hasHeldOrder = heldRows.some((r) => !!r.data)

  return {
    network: normalized,
    volumeGb: latest.volumeGb,
    // Masked — this order may belong to any customer on the platform, not the
    // dashboard viewer, so the full number is never sent to the client.
    recipientPhone: maskPhone(latest.phone),
    createdAt: latest.createdAt,
    completedAt: latest.updatedAt,
    durationMinutes,
    avgNetworkDurationMinutes,
    isNight: isNightTime(latest.createdAt),
    hasHeldOrder,
  }
}

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
  const rows = await fetchResolvedOrderRows(supabase, windowHours)

  const buckets = new Map<HealthNetwork, NetworkBucket>()
  for (const network of HEALTH_NETWORKS) {
    buckets.set(network, { completed: 0, resolved: 0, completedDurations: [] })
  }

  for (const row of rows) {
    const bucket = buckets.get(row.network)!
    bucket.resolved++
    if (row.status === "completed") {
      bucket.completed++
      if (row.durationMinutes !== null) bucket.completedDurations.push(row.durationMinutes)
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
