/** Pure helpers for the Release 3 developer dashboard UI (browser-safe: no server imports). */

export const DASH_TABS = ["overview", "keys", "usage", "logs", "orders", "docs"] as const
export type DashTab = (typeof DASH_TABS)[number]

export function parseTab(v: string | null | undefined): DashTab {
  return (DASH_TABS as readonly string[]).includes(v ?? "") ? (v as DashTab) : "overview"
}

/** Plain words for the log reason slugs (lib/api-v2/log-reason.ts). Unknown slugs read as words; http_N as a status. */
const REASON_WORDS: Record<string, string> = {
  key_pending: "Key waiting for approval",
  key_revoked: "Key revoked",
  account_suspended: "Account suspended",
  not_eligible: "Account not allowed API access",
  unavailable: "Service temporarily unavailable",
  developer_paused: "API access paused by Datagod",
  daily_limit: "Daily spending limit reached",
  service_paused: "Service paused by Datagod",
  wrong_key_type: "Wrong key type for this endpoint",
  insufficient_balance: "Wallet balance too low",
  insufficient_credits: "Not enough SMS credits",
  reference_reused: "Reference already used",
  request_in_progress: "Same reference still processing",
  outcome_unknown: "Outcome not confirmed yet",
  network_mismatch: "Number does not match the network",
  phone_not_verified: "Account phone not verified",
  recipient_not_registered: "Number not registered",
  invalid_request: "Invalid request",
  invalid_amount: "Invalid amount",
  internal_error: "Internal error",
  price_changed: "Price changed",
  out_of_stock: "Out of stock",
}

export function reasonLabel(slug: string | null | undefined): string {
  if (!slug) return ""
  if (REASON_WORDS[slug]) return REASON_WORDS[slug]
  const http = /^http_(\d{3})$/.exec(slug)
  if (http) return `HTTP ${http[1]}`
  const words = slug.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export interface DayPoint {
  day: string
  ok: number
  failed: number
}

export function usageTotals(daily: DayPoint[]): { ok: number; failed: number; total: number; successRate: number | null } {
  const ok = daily.reduce((s, d) => s + (Number(d.ok) || 0), 0)
  const failed = daily.reduce((s, d) => s + (Number(d.failed) || 0), 0)
  const total = ok + failed
  return { ok, failed, total, successRate: total ? Math.round((ok / total) * 1000) / 10 : null }
}

export type Tone = "primary" | "amber" | "green" | "red" | "slate"

export function orderTone(status: string): Tone {
  switch (status) {
    case "completed":
      return "green"
    case "failed":
      return "red"
    case "refunded":
      return "slate"
    case "unknown":
      return "amber"
    default:
      return "primary"
  }
}

export function httpTone(code: number): Tone {
  if (code < 400) return "green"
  if (code < 500) return "amber"
  return "red"
}

export const ghs = (n: number | string | null | undefined): string => {
  if (n === null || n === undefined || n === "") return "-"
  const v = Number(n)
  return Number.isFinite(v) ? `GHS ${v.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "-"
}

/**
 * Stale-response guard: each load takes a ticket; only the newest ticket may apply its answer, so a slow earlier
 * response can never overwrite a newer filter's rows or append an old page (final review I1).
 */
export function latestGate(): { next(): number; isLatest(ticket: number): boolean } {
  let n = 0
  return { next: () => ++n, isLatest: (t) => t === n }
}

/** The list with one order's status replaced, matched by product and reference (never by its position). */
export function withStatus<T extends { product: string; reference: string; status: string }>(rows: T[], product: string, reference: string, status: string): T[] {
  return rows.map((r) => (r.product === product && r.reference === reference ? { ...r, status } : r))
}

/** "2026-11-25T10:00:00.123456+00:00" -> "25 Nov, 10:00" (GMT = Ghana time). */
export function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]
  return `${d.getUTCDate()} ${m}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
}
