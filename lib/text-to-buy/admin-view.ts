import type { Line, Outcome } from "./types"

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

/** Both lines always appear. The shop line is stage 3: it is reported disabled and shows whatever the database holds (zeros). */
export function buildOverview(
  rows: OverviewRow[],
  heard: Record<Line, Date | null>,
  main: { enabled: boolean; number: string },
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
  return { main: line("main", main.enabled, main.number), shop: line("shop", false, "") }
}
