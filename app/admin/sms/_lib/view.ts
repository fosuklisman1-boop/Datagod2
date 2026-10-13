/** Pure view helpers for the admin SMS Platform page (no React, no I/O — unit-tested). */

export type Tone = "success" | "warning" | "danger" | "neutral"

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const withCommas = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

export function formatCount(v: unknown): string {
  return withCommas(Math.trunc(num(v)).toString())
}

export function formatGhs(v: unknown): string {
  const n = Math.round(num(v) * 100) / 100
  const [whole, dec] = Math.abs(n).toFixed(2).split(".")
  return `${n < 0 ? "-" : ""}GH₵${withCommas(whole)}.${dec}`
}

export function formatPerSms(priceGhs: unknown, units: unknown): string {
  const u = num(units)
  if (u <= 0) return "—"
  return `GH₵${(num(priceGhs) / u).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`
}

/** Per-SMS rate with trailing zeros trimmed (e.g. 0.035 -> GH₵0.035). */
export function formatRate(rate: unknown): string {
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) return "—"
  return `GH₵${Number(rate).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`
}

/** Only the last 4 digits of a Ghana Card number are ever stored. */
export function maskIdCard(last4: string | null | undefined): string {
  return last4 && /^\d{4}$/.test(last4) ? `ID ending ${last4}` : "—"
}

export function waLink(raw: string | null | undefined): string | null {
  let d = (raw ?? "").replace(/\D/g, "")
  if (d.startsWith("0") && d.length === 10) d = `233${d.slice(1)}`
  return /^233\d{9}$/.test(d) ? `https://wa.me/${d}` : null
}

const TONES: Record<string, Tone> = {
  sent: "success", active: "success", approved: "success", delivered: "success", completed: "success",
  pending: "warning", submitted: "warning", queued: "warning", sending: "warning", paused: "warning",
  held: "warning", scheduled: "warning", partial: "warning", open: "warning", inactive: "warning", info: "warning",
  failed: "danger", rejected: "danger", revoked: "danger", blocked: "danger", suspended: "danger", fraud: "danger",
  draft: "neutral", dismissed: "neutral", actioned: "neutral",
}
export function statusTone(status: string): Tone {
  return TONES[(status ?? "").toLowerCase()] ?? "neutral"
}
export function toneClass(t: Tone): string {
  switch (t) {
    case "success": return "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    case "warning": return "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300"
    case "danger": return "border-transparent bg-red-500/15 text-red-700 dark:text-red-300"
    default: return "border-transparent bg-muted text-muted-foreground"
  }
}
const LABELS: Record<string, string> = { submitted: "Under review", inactive: "Not activated" }
export function statusLabel(status: string): string {
  const s = (status ?? "").toLowerCase()
  if (LABELS[s]) return LABELS[s]
  const t = s.replace(/_/g, " ")
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "—"
  if (t > now) return "soon"
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(t).toISOString().slice(0, 10)
}

export function pageInfo(page: number, pageSize: number, total: number) {
  return {
    pages: Math.max(1, Math.ceil(total / pageSize)),
    from: total === 0 ? 0 : (page - 1) * pageSize + 1,
    to: Math.min(total, page * pageSize),
  }
}

/** True when the current page is past the first yet came back empty (e.g. a filter shrank the result set). */
export function shouldResetPage(page: number, rowsLength: number): boolean {
  return page > 1 && rowsLength === 0
}

export function messageBreakdown(r: { tracked: unknown; delivered: unknown; failed: unknown; pending: unknown }): string | null {
  if (num(r.tracked) <= 0) return null
  return `${formatCount(r.delivered)} delivered · ${formatCount(r.failed)} failed · ${formatCount(r.pending)} pending`
}
export function accountCredits(r: { bought: unknown; used: unknown }): string {
  return `${formatCount(r.bought)} bought · ${formatCount(r.used)} used`
}
export function groupReviews<T extends { status: string }>(rows: T[]) {
  return {
    pending: rows.filter((r) => r.status === "submitted"),
    approved: rows.filter((r) => r.status === "approved"),
    rejected: rows.filter((r) => r.status === "rejected"),
  }
}

export function providerLabel(p: string): string {
  return p === "hubtel" ? "Hubtel" : p === "moolre" ? "Moolre" : p
}
export function supplyHeadline(s: { backedCredits: number; error?: string }): string {
  return s.error ? `Supply unknown — ${s.error}` : `${formatCount(s.backedCredits)} credits backed`
}
export function bannerFor(o: { featureEnabled: boolean; provider: string; supply: { backedCredits: number; error?: string } }): { tone: Tone; text: string } {
  if (!o.featureEnabled) return { tone: "danger", text: "Paused — customers cannot send SMS or buy credits" }
  if (o.supply.error) return { tone: "warning", text: `Live — but credit sales may be paused: ${o.supply.error}` }
  if (o.supply.backedCredits <= 0) return { tone: "warning", text: "Live — but credit sales are paused: no backed supply" }
  return { tone: "success", text: "Live — customers can buy credits and send SMS" }
}
export function previewTotals(rows: { decision: string; code: string; count: number }[]) {
  const byDecision: Record<string, number> = {}
  let total = 0
  for (const r of rows) { byDecision[r.decision] = (byDecision[r.decision] ?? 0) + r.count; total += r.count }
  return { total, byDecision }
}

export const TAB_IDS = ["business-reviews", "sender-ids", "flagged", "messages", "accounts", "bundles", "settings"] as const
export type TabId = (typeof TAB_IDS)[number]
export function tabFromParam(p: string | null | undefined): TabId {
  return (TAB_IDS as readonly string[]).includes(p ?? "") ? (p as TabId) : "business-reviews"
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** API rate-limit override input: empty = platform default (null); otherwise a whole number 1–10,000. */
export function parseApiLimit(input: string): Parsed<number | null> {
  const t = (input ?? "").trim()
  if (t === "") return { ok: true, value: null }
  const n = Number(t)
  if (/^\d+$/.test(t) && n >= 1 && n <= 10000) return { ok: true, value: n }
  return { ok: false, error: "Enter a whole number from 1 to 10,000, or leave empty for the default" }
}

/** Credit allocation input: whole number 1–1,000,000. */
export function parseAllocateUnits(input: string): Parsed<number> {
  const t = (input ?? "").trim()
  const n = Number(t)
  if (/^\d+$/.test(t) && n >= 1 && n <= 1_000_000) return { ok: true, value: n }
  return { ok: false, error: "Enter a whole number from 1 to 1,000,000" }
}

export interface BundleDraftInput { name: string; units: string; price: string; sort: string }
/** Validates the bundle form; returns the numeric fields on success. */
export function parseBundleDraft(d: BundleDraftInput): Parsed<{ name: string; units: number; price: number; sort: number }> {
  const name = (d.name ?? "").trim()
  if (!name) return { ok: false, error: "Give the bundle a name" }
  const unitsText = (d.units ?? "").trim()
  const units = Number(unitsText)
  if (!/^\d+$/.test(unitsText) || units < 1 || units > 10_000_000) return { ok: false, error: "Credits must be a whole number from 1 to 10,000,000" }
  const priceText = (d.price ?? "").trim()
  const price = Number(priceText)
  if (!/^\d+(\.\d{1,2})?$/.test(priceText) || !(price > 0) || price > 100_000) return { ok: false, error: "Enter a price above 0 (up to 2 decimals)" }
  const sortText = (d.sort ?? "").trim()
  if (!/^-?\d+$/.test(sortText)) return { ok: false, error: "Sort order must be a whole number" }
  return { ok: true, value: { name, units, price, sort: Number(sortText) } }
}

/** Settings number input → number. Empty/whitespace/non-numeric → NaN so the server's validation message shows (never a silent 0). */
export function toNumberOrNaN(text: string): number {
  const t = (text ?? "").trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN
  return Number(t)
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`

/** "500 recipients · 1,000 credits" for a held campaign card. */
export function heldSummary(r: { recipients_count: unknown; credits_reserved: unknown }): string {
  return `${plural(num(r.recipients_count), "recipient")} · ${plural(num(r.credits_reserved), "credit")}`
}

/** Reject needs a reason the customer will see (the server enforces the same minimum). */
export function isValidRejectReason(reason: string): boolean {
  return (reason ?? "").trim().length >= 3
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "1 Jan, 09:00 GMT" (Ghana time is GMT). Unparseable input is returned as-is. */
export function formatGmt(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0")
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} GMT`
}

/** Toast text after a held-campaign action succeeded. */
export function heldActionMessage(
  action: "release" | "reject",
  d: { already?: boolean; placed?: unknown; refundedCredits?: unknown; status?: string; scheduled?: boolean; scheduledFor?: string },
): string {
  if (action === "release") {
    if (d.already) return d.status === "scheduled" ? "Already approved — scheduled" : "Already released"
    if (d.scheduled && d.scheduledFor) return `Approved — will be sent at ${formatGmt(d.scheduledFor)}`
    const placed = num(d.placed)
    return placed > 0 ? `Released — ${plural(placed, "message")} sent` : "Released — queued for sending"
  }
  if (d.already) return "Already rejected"
  const credits = num(d.refundedCredits)
  return credits > 0 ? `Rejected — ${plural(credits, "credit")} refunded` : "Rejected"
}

/** Toast text after PATCH { review_hold } on an account. */
export function reviewHoldMessage(hold: boolean, d: { review_hold_changed?: boolean; flags_closed?: number | null }): string {
  if (hold) return d.review_hold_changed ? "Account placed on review hold" : "Account was already on review hold"
  if (!d.review_hold_changed) return "Review hold was already cleared"
  if (d.flags_closed === null) return "Review hold cleared — open flags could not be closed; dismiss them in the Flagged tab"
  const n = num(d.flags_closed)
  return n > 0 ? `Review hold cleared — ${plural(n, "open flag")} closed` : "Review hold cleared"
}

/** Comma/newline separated text → trimmed, de-duplicated (case-insensitive), no empties. */
export function parseList(text: string): string[] {
  const seen = new Set<string>(); const out: string[] = []
  for (const part of (text ?? "").split(/[,\n]/)) {
    const t = part.trim()
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t) }
  }
  return out
}
