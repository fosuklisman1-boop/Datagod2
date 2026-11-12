import { GH_PHONE_RE } from "@/lib/support-validation"
import { getProviderDisplay } from "@/lib/mtn-providers/provider-display"
import type { SupplierResult } from "@/lib/order-supplier"
import type { SupportOrder } from "@/lib/support-order"

/* ---------- Contact links (strict checks; no link when the value is not clean) ---------- */

/** `233XXXXXXXXX` for a number that passes the Ghana phone check, else null. */
export function normalizeWhatsappDigits(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !GH_PHONE_RE.test(raw)) return null
  return raw.startsWith("+") ? raw.slice(1) : `233${raw.slice(1)}`
}

export function whatsappHref(raw: string | null | undefined): string | null {
  const digits = normalizeWhatsappDigits(raw)
  return digits ? `https://wa.me/${digits}` : null
}

export function telHref(raw: string | null | undefined): string | null {
  return typeof raw === "string" && GH_PHONE_RE.test(raw) ? `tel:${raw}` : null
}

/**
 * Exactly one `@`, something on both sides, no whitespace, no control characters and none of
 * `? & # % , < > " '` (a customer-controlled value must not add parameters to a mailto link).
 */
export function isPlausibleEmail(raw: string | null | undefined): boolean {
  // eslint-disable-next-line no-control-regex
  if (typeof raw !== "string" || /[\s?&#%,<>"'\u0000-\u001f\u007f]/.test(raw)) return false
  const parts = raw.split("@")
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0
}

export function mailtoHref(raw: string | null | undefined): string | null {
  return isPlausibleEmail(raw) ? `mailto:${raw}` : null
}

/** An attachment url is shown only when it is https; anything else renders nothing. */
export function safeAttachmentUrl(raw: string | null | undefined): string | null {
  return typeof raw === "string" && raw.startsWith("https://") ? raw : null
}

/**
 * Stale-response guard for loads that can overlap. Each load takes the next sequence number;
 * a response is applied only if it is newer than the last applied one and still belongs to
 * the thread (or window key) that is currently open.
 */
export function shouldApplyResponse(
  seq: number,
  lastApplied: number,
  responseThreadId: string,
  openThreadId: string | null,
): boolean {
  return seq > lastApplied && responseThreadId === openThreadId
}

/* ---------- Threads ---------- */

export interface AdminThreadListItem {
  id: string
  subject: string
  phone_number: string
  status: "open" | "closed"
  unread_count: number
  last_message_at: string
  user: { first_name: string | null; last_name: string | null; email: string | null; phone_number: string | null }
  order: SupportOrder | null
  last_message: { body: string; sender_role: string; created_at: string } | null
}

export function threadMatchesSearch(t: AdminThreadListItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const name = `${t.user?.first_name ?? ""} ${t.user?.last_name ?? ""}`
  const hay = [name, t.user?.email, t.subject, t.phone_number, t.user?.phone_number, t.order?.reference]
  return hay.some((v) => typeof v === "string" && v.toLowerCase().includes(q))
}

export function previewText(msg: { body: string; sender_role: string } | null, max = 80): string {
  if (!msg) return ""
  const text = `${msg.sender_role === "admin" ? "You: " : ""}${msg.body.replace(/\s+/g, " ").trim()}`
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Merge a refreshed list while keeping badges the admin zeroed locally (by opening
 * the conversation) at 0 until the server also reports 0. Overrides for rows that
 * disappeared or that the server now agrees on are released.
 */
export function mergeThreadList<T extends { id: string; unread_count: number }>(
  _previous: T[],
  next: T[],
  zeroed: ReadonlySet<string>,
): { threads: T[]; zeroed: Set<string> } {
  const kept = new Set<string>()
  const threads = next.map((t) => {
    if (!zeroed.has(t.id)) return t
    if (t.unread_count === 0) return t
    kept.add(t.id)
    return { ...t, unread_count: 0 }
  })
  return { threads, zeroed: kept }
}

/* ---------- Legacy complaints ---------- */

export type DatePreset = "all" | "today" | "yesterday" | "7d" | "custom"

export interface LegacyListItem {
  id: string
  title: string | null
  description: string | null
  status: string
  created_at: string
  user: { first_name: string | null; last_name: string | null; email: string | null }
  order: SupportOrder | null
}

export interface LegacyFilters {
  search: string
  status: string
  preset: DatePreset
  from: string
  to: string
}

export function legacyStatusCounts(items: { status: string }[]) {
  const counts = { all: items.length, pending: 0, in_review: 0, resolved: 0, rejected: 0 }
  for (const i of items) {
    if (i.status === "pending" || i.status === "in_review" || i.status === "resolved" || i.status === "rejected") {
      counts[i.status] += 1
    }
  }
  return counts
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

function dateRange(f: LegacyFilters, now: Date): { start: number; end: number } | null {
  const today = startOfDay(now)
  const day = 86_400_000
  switch (f.preset) {
    case "today":
      return { start: today.getTime(), end: today.getTime() + day }
    case "yesterday":
      return { start: today.getTime() - day, end: today.getTime() }
    case "7d":
      return { start: today.getTime() - 6 * day, end: today.getTime() + day }
    case "custom": {
      const from = parseLocalDate(f.from)
      const to = parseLocalDate(f.to)
      if (!from && !to) return null
      return {
        start: from ? from.getTime() : -Infinity,
        end: to ? to.getTime() + day : Infinity,
      }
    }
    default:
      return null
  }
}

export function filterLegacy<T extends LegacyListItem>(items: T[], f: LegacyFilters, now: Date = new Date()): T[] {
  const q = f.search.trim().toLowerCase()
  const range = dateRange(f, now)
  return items.filter((c) => {
    if (f.status !== "all" && c.status !== f.status) return false
    if (range) {
      const t = Date.parse(c.created_at)
      if (Number.isNaN(t) || t < range.start || t >= range.end) return false
    }
    if (!q) return true
    const name = `${c.user?.first_name ?? ""} ${c.user?.last_name ?? ""}`
    const hay = [name, c.user?.email, c.title, c.description, c.order?.reference, c.order?.beneficiary]
    return hay.some((v) => typeof v === "string" && v.toLowerCase().includes(q))
  })
}

/* ---------- Supplier badge ---------- */

export function supplierBadgeModel(supplier: SupplierResult): { label: string; className: string } {
  const muted = "bg-muted text-muted-foreground border-border"
  if (supplier === null) return { label: "N/A", className: muted }
  if (supplier.kind === "manual") return { label: "Manual", className: "bg-primary/10 text-primary border-primary/20" }
  const d = getProviderDisplay(supplier.provider)
  return {
    label: supplier.attemptedOnly ? `Last tried: ${d.label}` : d.label,
    className: d.badgeClassName,
  }
}

/* ---------- Display helpers ---------- */

export function userDisplayName(u: { first_name: string | null; last_name: string | null; email: string | null } | null | undefined): string {
  const name = `${u?.first_name ?? ""} ${u?.last_name ?? ""}`.trim()
  return name || u?.email || "Unknown user"
}
