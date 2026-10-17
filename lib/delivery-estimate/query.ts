// Live delivery estimate: the database side. Finds the reference orders C and P for each channel across
// every table a real order can land in, loads the admin "mark down" overrides, and hands both to the pure
// formulas in ./compute. Caller owns the Supabase client (service role).
//
// Query shape, per channel and per source table (then merged across tables in JS):
//   C: SELECT created_at, updated_at FROM <table>
//        WHERE <status> = 'completed' [AND payment_status = <paid>] AND <network matches channel>
//        ORDER BY created_at DESC LIMIT 1                      -- latest PLACED, never latest finished
//      C = the row with the greatest created_at across tables.
//   P: SELECT created_at FROM <table>
//        WHERE <status> IN ('pending','processing') [AND payment_status = <paid>] AND <network matches>
//          AND created_at >= C.created_at                       -- anchored to C's PLACEMENT time
//        ORDER BY created_at ASC LIMIT 1
//      P = the row with the smallest created_at across tables.
// 'held_registration' (MTN number-validation hold) and unpaid checkouts are never "in flight". Order tables
// have no delivered_at: a completed row's updated_at is its completion time (set by the status flip).

import type { SupabaseClient } from "@supabase/supabase-js"
import { computeEstimate, type ChannelEstimate, type ChannelOverride, type OpenOrder, type ReferenceOrder } from "./compute"

export const DELIVERY_CHANNELS = [
  { key: "mtn", label: "MTN" },
  { key: "telecel", label: "Telecel" },
  { key: "at_ishare", label: "AT - iShare" },
  { key: "at_bigtime", label: "AT - BigTime" },
  { key: "utility", label: "Utility Bills" },
  { key: "standard", label: "Standard Bundles" },
] as const
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number]["key"]
export const isDeliveryChannel = (v: unknown): v is DeliveryChannel => DELIVERY_CHANNELS.some(c => c.key === v)

export const OVERRIDES_TABLE = "delivery_channel_overrides"
const IN_FLIGHT = ["pending", "processing"]

interface Source {
  table: string
  statusColumn: "status" | "order_status"
  /** Only paid rows are real orders (an abandoned checkout is not a delivery). */
  paid?: { column: string; value: string }
}

// The 5 data tables (same set as lib/order-health-service.ts) and the bill orders table.
const DATA_SOURCES: Source[] = [
  { table: "orders", statusColumn: "status" },
  { table: "api_orders", statusColumn: "status" },
  { table: "shop_orders", statusColumn: "order_status", paid: { column: "payment_status", value: "completed" } },
  { table: "ussd_orders", statusColumn: "order_status", paid: { column: "payment_status", value: "completed" } },
  { table: "ussd_shop_orders", statusColumn: "order_status", paid: { column: "payment_status", value: "completed" } },
]
const BILL_SOURCES: Source[] = [{ table: "hubtel_bill_orders", statusColumn: "status", paid: { column: "payment_status", value: "paid" } }]
// Standard Bundles (Hubtel-fulfilled data, all networks; also what USSD "Standard Bundles" sells).
const STANDARD_SOURCES: Source[] = [{ table: "hubtel_data_orders", statusColumn: "status", paid: { column: "payment_status", value: "paid" } }]

/** Channels that are a whole product line (one table, every network), not a single data network. */
type ProductChannel = "utility" | "standard"
const isProductChannel = (c: DeliveryChannel): c is ProductChannel => c === "utility" || c === "standard"

// Network spellings per channel (case-insensitive), matching normalizeNetwork in lib/order-health-service.ts.
// Bare "AT"/"AirtelTigo" belongs to neither AT bucket and is left out.
const NETWORK_SPELLINGS: Record<Exclude<DeliveryChannel, ProductChannel>, string[]> = {
  mtn: ["mtn"],
  telecel: ["telecel"],
  at_ishare: ["at - ishare", "ishare", "at-ishare"],
  at_bigtime: ["at - bigtime", "at-bigtime", "bigtime"],
}

function scoped(q: any, source: Source, channel: DeliveryChannel): any {
  if (source.paid) q = q.eq(source.paid.column, source.paid.value)
  if (!isProductChannel(channel)) {
    const names = NETWORK_SPELLINGS[channel]
    q = names.length === 1 ? q.ilike("network", names[0]) : q.or(names.map(n => `network.ilike.${n}`).join(","))
  }
  return q
}

const sourcesFor = (channel: DeliveryChannel) => (channel === "utility" ? BILL_SOURCES : channel === "standard" ? STANDARD_SOURCES : DATA_SOURCES)

/** Pure: C = latest-placed completed candidate. */
export function pickC(candidates: Array<ReferenceOrder | null>): ReferenceOrder | null {
  let best: ReferenceOrder | null = null
  for (const c of candidates) if (c && (!best || Date.parse(c.createdAt) > Date.parse(best.createdAt))) best = c
  return best
}

/** Pure: P = oldest open candidate placed at or after C was placed. */
export function pickP(c: ReferenceOrder, candidates: Array<OpenOrder | null>): OpenOrder | null {
  const anchor = Date.parse(c.createdAt)
  let best: OpenOrder | null = null
  for (const p of candidates) {
    if (!p || Date.parse(p.createdAt) < anchor) continue
    if (!best || Date.parse(p.createdAt) < Date.parse(best.createdAt)) best = p
  }
  return best
}

async function findC(db: SupabaseClient, channel: DeliveryChannel): Promise<ReferenceOrder | null> {
  const rows = await Promise.all(sourcesFor(channel).map(async source => {
    const q = scoped(db.from(source.table).select("created_at, updated_at").eq(source.statusColumn, "completed"), source, channel)
    const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (error) throw new Error(`[DELIVERY-ESTIMATE] ${source.table} C lookup failed: ${error.message}`)
    const r = data as { created_at?: string; updated_at?: string } | null
    return r?.created_at && r.updated_at ? { createdAt: r.created_at, completedAt: r.updated_at } : null
  }))
  return pickC(rows)
}

async function findP(db: SupabaseClient, channel: DeliveryChannel, c: ReferenceOrder): Promise<OpenOrder | null> {
  const rows = await Promise.all(sourcesFor(channel).map(async source => {
    const q = scoped(db.from(source.table).select("created_at").in(source.statusColumn, IN_FLIGHT), source, channel)
    const { data, error } = await q.gte("created_at", c.createdAt).order("created_at", { ascending: true }).limit(1).maybeSingle()
    if (error) throw new Error(`[DELIVERY-ESTIMATE] ${source.table} P lookup failed: ${error.message}`)
    const r = data as { created_at?: string } | null
    return r?.created_at ? { createdAt: r.created_at } : null
  }))
  return pickP(c, rows)
}

/** Overrides by channel. A missing table (migration not applied yet) reads as "nothing overridden". */
export async function loadOverrides(db: SupabaseClient): Promise<Map<DeliveryChannel, ChannelOverride>> {
  const out = new Map<DeliveryChannel, ChannelOverride>()
  const { data, error } = await db.from(OVERRIDES_TABLE).select("channel, is_manually_down, reason, since, frozen")
  if (error) {
    console.warn("[DELIVERY-ESTIMATE] overrides unavailable:", error.message)
    return out
  }
  for (const r of (data ?? []) as any[]) {
    if (!isDeliveryChannel(r.channel)) continue
    out.set(r.channel, { isManuallyDown: !!r.is_manually_down, reason: r.reason ?? null, since: r.since ?? null, frozen: r.frozen ?? null })
  }
  return out
}

export interface ChannelEstimateRow extends ChannelEstimate { channel: DeliveryChannel; label: string }

/** Live estimate for one channel, ignoring overrides (used for the "mark down" snapshot too). */
export async function computeLiveEstimate(db: SupabaseClient, channel: DeliveryChannel, now = new Date().toISOString()): Promise<ChannelEstimate> {
  const c = await findC(db, channel)
  const p = c ? await findP(db, channel, c) : null
  return computeEstimate({ c, p, now })
}

/** Every channel, overrides applied. A down channel is not recomputed (its numbers stay frozen). */
export async function getDeliveryEstimates(db: SupabaseClient, now = new Date().toISOString()): Promise<ChannelEstimateRow[]> {
  const overrides = await loadOverrides(db)
  return Promise.all(DELIVERY_CHANNELS.map(async ({ key, label }) => {
    const override = overrides.get(key)
    const estimate = override?.isManuallyDown
      ? computeEstimate({ c: null, p: null, now, override })
      : await computeLiveEstimate(db, key, now)
    return { channel: key, label, ...estimate }
  }))
}

// ---------------------------------------------------------------------------------------------------------
// Hot-path read for purchase confirmation screens: its own in-process cache, separate from the dashboard's
// live query, and it can never throw. A failed lookup is simply "show nothing".
// ---------------------------------------------------------------------------------------------------------

export const CONFIRM_CACHE_MS = 3 * 60_000
const confirmCache = new Map<DeliveryChannel, { at: number; value: ChannelEstimate | null }>()

export async function getCachedChannelEstimate(db: SupabaseClient, channel: DeliveryChannel, nowMs = Date.now()): Promise<ChannelEstimate | null> {
  try {
    const hit = confirmCache.get(channel)
    if (hit && nowMs - hit.at < CONFIRM_CACHE_MS) return hit.value
    const now = new Date(nowMs).toISOString()
    const override = (await loadOverrides(db)).get(channel)
    const value = override?.isManuallyDown ? computeEstimate({ c: null, p: null, now, override }) : await computeLiveEstimate(db, channel, now)
    confirmCache.set(channel, { at: nowMs, value })
    return value
  } catch (e) {
    console.warn("[DELIVERY-ESTIMATE] confirm-screen lookup failed (ignored):", e instanceof Error ? e.message : e)
    return null
  }
}

/** Test hook. */
export function clearConfirmCache(): void { confirmCache.clear() }

/** Network name as stored on a data order (any spelling) -> channel. */
export function channelForNetwork(network: string | null | undefined): DeliveryChannel | null {
  const n = (network ?? "").toLowerCase().trim()
  for (const [channel, names] of Object.entries(NETWORK_SPELLINGS)) if (names.includes(n)) return channel as DeliveryChannel
  return null
}

// ---------------------------------------------------------------------------------------------------------
// Public read (landing page, storefronts): anyone can call it, so one computation is shared by every visitor
// for a few seconds. The numbers carry no customer data, only durations, timestamps and labels.
// ---------------------------------------------------------------------------------------------------------

export const PUBLIC_CACHE_MS = 15_000
let publicCache: { at: number; value: Promise<ChannelEstimateRow[]> } | null = null

export function getPublicDeliveryEstimates(db: SupabaseClient, nowMs = Date.now()): Promise<ChannelEstimateRow[]> {
  if (publicCache && nowMs - publicCache.at < PUBLIC_CACHE_MS) return publicCache.value
  // Cache the in-flight promise too, so a burst of visitors triggers one computation, not one each.
  const value = getDeliveryEstimates(db, new Date(nowMs).toISOString())
  publicCache = { at: nowMs, value }
  value.catch(() => { if (publicCache?.value === value) publicCache = null }) // never cache a failure
  return value
}

/** Test hook. */
export function clearPublicCache(): void { publicCache = null }
