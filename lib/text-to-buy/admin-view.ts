import type { Line, Outcome } from "./types"
import { readPhoneLink } from "./phone-sms/config"

// Read-model helpers for the Text-to-Buy admin API. Pure. Message text and numbers pass through here: never log them.

/** Hubtel's one-segment SMS rate in GHS, measured on 2026-11-13. The Overview shows replies x this. Change it here only. */
export const SMS_RATE_GHS = 0.0243

export const LINES: readonly Line[] = ["main", "shop"]
export const isLine = (x: unknown): x is Line => typeof x === "string" && (LINES as readonly string[]).includes(x)

// Record<Outcome, true> makes the compiler fail here when a new Outcome is added to the union and not to this list.
const OUTCOME_SET: Record<Outcome, true> = {
  prompted: true, asked: true, price_answer: true, keyword: true, late: true, limited: true, open_order: true,
  not_order: true, unavailable: true, blocked: true, duplicate: true, off: true, error: true,
}
export const OUTCOMES = Object.keys(OUTCOME_SET) as Outcome[]
export const isOutcome = (x: unknown): x is Outcome => typeof x === "string" && Object.prototype.hasOwnProperty.call(OUTCOME_SET, x)

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A timestamptz as PostgREST returns it, UTC only. Strict on purpose: the value ends up inside a PostgREST or() filter.
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$/

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString("base64url")
}

/** Null for anything that is not a cursor this module produced (garbage, tampered, wrong shape). */
export function decodeCursor(c: string | null): { createdAt: string; id: string } | null {
  if (!c || c.length > 200) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(c, "base64url").toString("utf8"))
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [createdAt, id] = parsed
    if (typeof createdAt !== "string" || typeof id !== "string") return null
    if (!TS_RE.test(createdAt) || !UUID_RE.test(id)) return null
    if (Number.isNaN(Date.parse(createdAt))) return null
    return { createdAt, id }
  } catch {
    return null
  }
}

export type AdminMessage = {
  id: string
  createdAt: string
  line: Line
  sender: string
  direction: "in" | "out"
  body: string
  readBy: "rules" | "ai" | null
  outcome: string | null
  orderLinkId: string | null
  misread: boolean
}

export const MESSAGE_COLUMNS = "id, created_at, line, sender, direction, body, read_by, outcome, order_link_id, misread"

export function toAdminMessage(r: Record<string, unknown>): AdminMessage {
  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    line: r.line === "shop" ? "shop" : "main",
    sender: String(r.sender),
    direction: r.direction === "out" ? "out" : "in",
    body: String(r.body ?? ""),
    readBy: r.read_by === "rules" || r.read_by === "ai" ? r.read_by : null,
    outcome: typeof r.outcome === "string" ? r.outcome : null,
    orderLinkId: typeof r.order_link_id === "string" ? r.order_link_id : null,
    misread: r.misread === true,
  }
}

/** 00:00 Africa/Accra, which is UTC all year (no daylight saving). */
export function startOfTodayAccra(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export type OverviewRow = { line: Line; texts: number; prompts: number; paid: number; delivered: number; replies: number; aiReads: number; ruleReads: number }
export type LineOverview = {
  enabled: boolean
  number: string
  lastHeardAt: string | null
  today: Omit<OverviewRow, "line">
  smsCostGhs: number
}

const ZERO = { texts: 0, prompts: 0, paid: 0, delivered: 0, replies: 0, aiReads: 0, ruleReads: 0 }

/** Both lines always appear, each from its own settings (the shop card defaults to off and unset when not given). */
export function buildOverview(
  rows: OverviewRow[],
  heard: Record<Line, Date | null>,
  main: { enabled: boolean; number: string },
  shop: { enabled: boolean; number: string } = { enabled: false, number: "" },
): Record<Line, LineOverview> {
  const line = (l: Line, enabled: boolean, number: string): LineOverview => {
    const r = rows.find((x) => x.line === l)
    const today = r ? { texts: r.texts, prompts: r.prompts, paid: r.paid, delivered: r.delivered, replies: r.replies, aiReads: r.aiReads, ruleReads: r.ruleReads } : { ...ZERO }
    return {
      enabled,
      number,
      lastHeardAt: heard[l] ? heard[l]!.toISOString() : null,
      today,
      smsCostGhs: Math.round(today.replies * SMS_RATE_GHS * 10_000) / 10_000,
    }
  }
  return { main: line("main", main.enabled, main.number), shop: line("shop", shop.enabled, shop.number) }
}

export type CallCounts = { replied: number; skipped: number }
export type CallsOverview = { enabled: boolean; today: Record<Line, CallCounts> }

const count = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0)

/** The missed-call card: the switch and today's two counts per line. Counts only; anything else on the input is dropped. */
export function buildCallsOverview(enabled: boolean, counts: Partial<Record<Line, Partial<CallCounts>>> | null): CallsOverview {
  const one = (l: Line): CallCounts => ({ replied: count(counts?.[l]?.replied), skipped: count(counts?.[l]?.skipped) })
  return { enabled, today: { main: one("main"), shop: one("shop") } }
}

/**
 * Whether the SIM reply link is configured: SMS_PHONE_URL is an http(s) URL and SMS_PHONE_SM4_KEY is 32 hex characters.
 * A boolean only: the values never leave the server.
 */
export function phoneLinkConfigured(env: Record<string, string | undefined>): boolean {
  return readPhoneLink(env) !== null
}

export type PausedShop = {shopId: string; name: string; count: number }

/**
 * Today's "paused" notices to a list of shops: ids, display names and counts ONLY (never a sender or any phone).
 * The display name is the shop's USSD display name, else its shop name, else "Shop". Most notices first, then by id.
 */
export function shapePausedShops(
  notices: { shop_id: unknown }[],
  shops: { id: unknown; shop_name?: unknown; ussd_display_name?: unknown }[],
): PausedShop[] {
  const counts = new Map<string, number>()
  for (const n of notices) if (typeof n.shop_id === "string") counts.set(n.shop_id, (counts.get(n.shop_id) ?? 0) + 1)
  const nameOf = new Map<string, string>()
  for (const s of shops) {
    if (typeof s.id !== "string") continue
    const name = [s.ussd_display_name, s.shop_name].find((x) => typeof x === "string" && x.trim() !== "")
    if (typeof name === "string") nameOf.set(s.id, name.trim())
  }
  return [...counts.entries()]
    .map(([shopId, count]) => ({ shopId, name: nameOf.get(shopId) ?? "Shop", count }))
    .sort((a, b) => b.count - a.count || (a.shopId < b.shopId ? -1 : 1))
}
