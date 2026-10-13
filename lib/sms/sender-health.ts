/**
 * Sender ID health (admin SMS health page). Pure helpers over the rows returned by the
 * sms_sender_health(p_hours) RPC (migrations/20261023_sms_sender_health.sql).
 *
 * Only Hubtel reports delivery, so every row is Hubtel traffic. The point is to spot sender
 * names that Hubtel accepts but a carrier silently drops (all sends end Expired/Undeliverable).
 */

/** "Not delivering": at least this many sends in the window and none delivered. */
export const NOT_DELIVERING_MIN_SENT = 10
/** "Degraded" needs at least this many final outcomes (delivered + failed)... */
export const DEGRADED_MIN_RESOLVED = 10
/** "Healthy" needs at least this many final outcomes (delivered + failed)... */
export const HEALTHY_MIN_RESOLVED = 5
/** ...and a delivery rate (delivered / (delivered + failed)) at or above this. Below it = degraded. */
export const HEALTHY_MIN_RATE = 0.7

export type SenderHealthStatus = "not_delivering" | "degraded" | "healthy" | "insufficient"

export interface SenderHealthCounts {
  delivered: number
  failed: number
  in_flight: number
  total: number
}

/**
 * Classify one sender name's window. Order matters:
 *  1. not_delivering — total >= 10 and delivered === 0. Deliberately simple: in-flight rows count
 *     towards "sent", because a name whose sends never come back delivered is the failure we hunt.
 *  2. degraded       — delivered + failed >= 10 and rate < 0.7
 *  3. healthy        — delivered + failed >= 5 and rate >= 0.7
 *  4. insufficient   — anything else (too few final outcomes to judge)
 */
export function senderHealthStatus(c: SenderHealthCounts): SenderHealthStatus {
  if (c.total >= NOT_DELIVERING_MIN_SENT && c.delivered === 0) return "not_delivering"
  const resolved = c.delivered + c.failed
  const rate = resolved > 0 ? c.delivered / resolved : 0
  if (resolved >= DEGRADED_MIN_RESOLVED && rate < HEALTHY_MIN_RATE) return "degraded"
  if (resolved >= HEALTHY_MIN_RESOLVED && rate >= HEALTHY_MIN_RATE) return "healthy"
  return "insufficient"
}

/** 'campaign' = customer/admin campaign sends (sms_messages); 'platform' = sendSMS() traffic (sms_logs). */
export type SenderHealthSource = "campaign" | "platform"

export interface SenderHealthRow extends SenderHealthCounts {
  sender: string
  /** A name can appear once per source. Absent from the pre-20261024 RPC → 'campaign'. */
  source: SenderHealthSource
  /** 0..1, null when there are no final outcomes yet. */
  delivery_rate: number | null
  last_delivered_at: string | null
  last_sent_at: string | null
  accounts: number
  /** Registry status from sms_sender_ids ('active' if any row is active, else the latest); null = not registered. */
  registry_status: string | null
  is_pool: boolean
  kyc_free: boolean
}

export type SenderHealthRowWithStatus = SenderHealthRow & { status: SenderHealthStatus }

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

/** Coerce the RPC's jsonb array into typed rows; anything that isn't an array becomes []. */
export function normalizeSenderHealthRows(raw: unknown): SenderHealthRow[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((r) => r && typeof r === "object")
    .map((r: any) => {
      const rate = r.delivery_rate === null || r.delivery_rate === undefined ? null : Number(r.delivery_rate)
      return {
        sender: String(r.sender ?? "(platform default)"),
        source: r.source === "platform" ? "platform" : "campaign",
        total: num(r.total),
        delivered: num(r.delivered),
        failed: num(r.failed),
        in_flight: num(r.in_flight),
        delivery_rate: rate !== null && Number.isFinite(rate) ? rate : null,
        last_delivered_at: strOrNull(r.last_delivered_at),
        last_sent_at: strOrNull(r.last_sent_at),
        accounts: num(r.accounts),
        registry_status: strOrNull(r.registry_status),
        is_pool: r.is_pool === true,
        kyc_free: r.kyc_free === true,
      }
    })
}

export function withHealthStatus(rows: SenderHealthRow[]): SenderHealthRowWithStatus[] {
  return rows.map((r) => ({ ...r, status: senderHealthStatus(r) }))
}

const STATUS_ORDER: Record<SenderHealthStatus, number> = { not_delivering: 0, degraded: 1, healthy: 2, insufficient: 3 }

/** Not delivering first, then degraded, healthy, too-few; ties by total desc. Returns a new array. */
export function sortSenderHealth<T extends { status: SenderHealthStatus; total: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.total - a.total)
}

export function formatDeliveryRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—"
  return `${Math.round(rate * 100)}%`
}

export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "Never"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "Never"
  const sec = Math.max(0, Math.floor((now.getTime() - t) / 1000))
  if (sec < 60) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

export const HEALTH_LABELS: Record<SenderHealthStatus, string> = {
  not_delivering: "Not delivering",
  degraded: "Degraded",
  healthy: "Healthy",
  insufficient: "Too few results",
}
