import { createHash } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { encodeCursor, MESSAGE_COLUMNS, shapePausedShops, toAdminMessage, type AdminMessage, type OverviewRow, type PausedShop } from "./admin-view"
import { orderTableFor, type AirtimeNetwork, type ExamBoardWord, type Line, type OrderTable, type Outcome, type ReadResult, type Service } from "./types"

/**
 * Text-to-Buy database access (tables and functions of migration 0177). Server-only, service-role client.
 * Never logs: not message bodies, not phone numbers, not database error text (which can echo row values).
 * Every failure is a TtbStoreError with a fixed message, so callers decide whether to fail closed.
 */

export class TtbStoreError extends Error {
  constructor(what: string) {
    super(`text-to-buy store: ${what}`)
    this.name = "TtbStoreError"
  }
}

type DbError = { code?: string } | null | undefined
const isUnique = (e: DbError) => e?.code === "23505"

// Constraint names from migration 0177 (a PGlite test pins that they exist).
const OPEN_INDEX = "ttb_orders_one_open"
const ORDER_ID_KEY = "ttb_orders_order_id_key"

const TWO_MINUTES_MS = 2 * 60_000
const CONVERSATION_TTL_MS = 20 * 60_000
const MAX_TURNS = 6

export type InboundRow = { id: string; duplicate: boolean }

/** sha256 hex of line|sender|text|receivedAtISO, or, with no receive time, line|sender|text|<2-minute bucket>. */
export function dedupeKey(line: Line, senderLocal: string, text: string, receivedAt: Date | null, now: Date): string {
  const when = receivedAt ? receivedAt.toISOString() : String(Math.floor(now.getTime() / TWO_MINUTES_MS))
  return createHash("sha256").update(`${line}|${senderLocal}|${text}|${when}`).digest("hex")
}

/** Idempotent on dedupe_key. Throws TtbStoreError only when the row could not be written (and is not already there). */
export async function storeInbound(
  db: SupabaseClient,
  m: { line: Line; sender: string; body: string; receivedAt: Date | null; now: Date; shopId?: string },
): Promise<InboundRow> {
  const key = dedupeKey(m.line, m.sender, m.body, m.receivedAt, m.now)
  const row: Record<string, unknown> = {
    line: m.line,
    sender: m.sender,
    direction: "in",
    body: m.body,
    received_at: m.receivedAt ? m.receivedAt.toISOString() : null,
    dedupe_key: key,
  }
  if (m.shopId !== undefined) row.shop_id = m.shopId
  const ins = await db
    .from("ttb_messages")
    .insert(row)
    .select("id")
    .single()
  if (!ins.error && ins.data) return { id: (ins.data as { id: string }).id, duplicate: false }
  if (!isUnique(ins.error)) throw new TtbStoreError("could not store an inbound message")

  const existing = await db.from("ttb_messages").select("id").eq("dedupe_key", key).maybeSingle()
  const id = (existing.data as { id?: string } | null)?.id
  if (existing.error || !id) throw new TtbStoreError("could not find the original of a duplicate message")
  return { id, duplicate: true }
}

export async function setInboundResult(
  db: SupabaseClient,
  id: string,
  r: { readBy: "rules" | "ai" | null; outcome: Outcome; orderLinkId?: string },
): Promise<void> {
  const patch: Record<string, unknown> = { read_by: r.readBy, outcome: r.outcome }
  if (r.orderLinkId !== undefined) patch.order_link_id = r.orderLinkId
  const { error } = await db.from("ttb_messages").update(patch).eq("id", id)
  if (error) throw new TtbStoreError("could not record a result")
}

export async function storeOutbound(
  db: SupabaseClient,
  m: { line: Line; sender: string; body: string; orderLinkId?: string; shopId?: string; credits?: number },
): Promise<void> {
  const row: Record<string, unknown> = { line: m.line, sender: m.sender, direction: "out", body: m.body }
  if (m.orderLinkId !== undefined) row.order_link_id = m.orderLinkId
  if (m.shopId !== undefined) row.shop_id = m.shopId
  if (m.credits !== undefined) row.credits = m.credits
  const { error } = await db.from("ttb_messages").insert(row)
  if (error) throw new TtbStoreError("could not store an outbound message")
}

export async function isBlocked(db: SupabaseClient, sender: string): Promise<boolean> {
  const { data, error } = await db.from("ttb_blocked").select("sender").eq("sender", sender).maybeSingle()
  if (error) throw new TtbStoreError("could not read the block list")
  return !!data
}

export async function counts(
  db: SupabaseClient,
  line: Line,
  sender: string,
  since: Date,
): Promise<{ promptsUnpaid: number; replies: number; aiReads: number; notUnderstood: number }> {
  const { data, error } = await db.rpc("ttb_counts", { p_line: line, p_sender: sender, p_since: since.toISOString() })
  if (error) throw new TtbStoreError("could not read counts")
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0)
  return {
    promptsUnpaid: n(row?.prompts_unpaid),
    replies: n(row?.replies),
    aiReads: n(row?.ai_reads),
    notUnderstood: n(row?.not_understood),
  }
}

export async function globalPrompts(db: SupabaseClient, since: Date): Promise<number> {
  const { data, error } = await db.rpc("ttb_global_prompts", { p_since: since.toISOString() })
  if (error || typeof data !== "number" || !Number.isFinite(data)) throw new TtbStoreError("could not read the global prompt count")
  return data
}

/** Outbound reply rows of a line created at or after since (a count query, no rows fetched). Throws TtbStoreError on a read error. */
export async function countOutbound(db: SupabaseClient, line: Line, since: Date, o: { datagodPaidOnly?: boolean } = {}): Promise<number> {
  let q = db
    .from("ttb_messages")
    .select("id", { count: "exact", head: true })
    .eq("line", line)
    .eq("direction", "out")
    .gte("created_at", since.toISOString())
  // Shop-paid rows carry shop_id; Datagod-paid rows never do. Only asked for on the shop line, so the main query never names the column.
  if (o.datagodPaidOnly) q = q.is("shop_id", null)
  const { count, error } = await q
  if (error || typeof count !== "number" || !Number.isFinite(count)) throw new TtbStoreError("could not read the outbound count")
  return count
}

/** An awaiting_payment link created at or after windowStart. */
export async function hasOpenOrder(db: SupabaseClient, line: Line, sender: string, windowStart: Date): Promise<boolean> {
  const { data, error } = await db
    .from("ttb_orders")
    .select("id")
    .eq("line", line)
    .eq("sender", sender)
    .eq("state", "awaiting_payment")
    .gte("created_at", windowStart.toISOString())
    .limit(1)
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not read open orders")
  return data.length > 0
}

/**
 * Links a placed order to its sender. Two different unique violations, two different results:
 *  - "conflict": the one-open-order index (ttb_orders_one_open) holds a row, so a concurrent text won; the caller closes
 *    the order it just placed.
 *  - { id, alreadyLinked: true }: this order_id is already linked (ttb_orders_order_id_key), e.g. a retry after a timeout
 *    whose first insert committed. The existing link stands and the caller must NOT fail the order.
 * The constraint name is read from the error to decide, and never copied anywhere. If the error does not name it, a lookup
 * of the order_id decides.
 */
export async function linkOrder(
  db: SupabaseClient,
  o: {
    line: Line; sender: string; service: Service; orderTable: OrderTable; orderId: string
    size: string; recipient: string; gift: boolean; amount: number
    /** The shop the order was placed for (shop line only; the column stays unwritten, so NULL, on the main line). */
    shopId?: string
  },
): Promise<{ id: string } | { id: string; alreadyLinked: true } | "conflict"> {
  // A link that names the wrong order table would make the notifier read the wrong row: refuse before writing anything.
  let expected: string | null
  try {
    expected = orderTableFor(o.line, o.service)
  } catch {
    expected = null
  }
  if (expected !== o.orderTable) throw new TtbStoreError("a link names an order table that is not its service's")
  const row: Record<string, unknown> = {
    line: o.line,
    sender: o.sender,
    service: o.service,
    order_table: o.orderTable,
    order_id: o.orderId,
    size: o.size,
    recipient: o.recipient,
    gift: o.gift,
    amount: o.amount,
  }
  if (o.shopId !== undefined) row.shop_id = o.shopId
  const { data, error } = await db
    .from("ttb_orders")
    .insert(row)
    .select("id")
    .single()
  if (isUnique(error)) {
    const text = `${(error as { message?: unknown }).message ?? ""} ${(error as { details?: unknown }).details ?? ""}`
    const named = text.includes(OPEN_INDEX) ? "open" : text.includes(ORDER_ID_KEY) ? "order_id" : null
    if (named === "open") return "conflict"
    const existing = await db.from("ttb_orders").select("id").eq("order_id", o.orderId).maybeSingle()
    if (existing.error) throw new TtbStoreError("could not look up an already-linked order")
    const existingId = (existing.data as { id?: string } | null)?.id
    if (existingId) return { id: existingId, alreadyLinked: true }
    if (named === "order_id") throw new TtbStoreError("an already-linked order could not be found")
    return "conflict"
  }
  const id = (data as { id?: string } | null)?.id
  if (error || !id) throw new TtbStoreError("could not link an order")
  return { id }
}

export type Pending =
  | { type: "choices"; options: { label: string; read: ReadResult }[] } // numbered question; a bare digit picks one
  | { type: "confirm"; read: ReadResult } // YES places this
  | { type: "quantity"; board: ExamBoardWord } // "How many checkers?" was asked: a bare whole number is the quantity
  | { type: "amount"; network: AirtimeNetwork | null } // "How much airtime?" was asked: a bare number is the airtime amount
  | { type: "shop"; read: ReadResult } // shop line: "Which shop?" was asked; a shop code in the next text completes this read
export type LastOrder =
  // data: the Stage 1 shape. shopCodeId is present only on shop-line orders, so AGAIN / YES re-resolve the same shop.
  | { sizeMb: number; network: string; recipient: string; shopCodeId?: string }
  | { service: "airtime"; amountGhs: number; network: string; recipient: string }
  | { service: "results_checker"; board: ExamBoardWord; quantity: number }
export type Conversation = {
  turns: { role: "user" | "assistant"; text: string }[]
  pending: Pending | null
  lastOrder: LastOrder | null
}

const EMPTY: Conversation = { turns: [], pending: null, lastOrder: null }

function parseTurns(x: unknown): Conversation["turns"] {
  if (!Array.isArray(x)) return []
  return x.flatMap((t) => {
    const r = t as { role?: unknown; text?: unknown } | null
    return r && (r.role === "user" || r.role === "assistant") && typeof r.text === "string" ? [{ role: r.role, text: r.text }] : []
  })
}

function parsePending(x: unknown): Pending | null {
  const p = x as { type?: unknown; board?: unknown; network?: unknown; read?: unknown } | null
  if (p && typeof p === "object" && p.type === "shop") {
    const r = p.read as { kind?: unknown } | null
    return r && typeof r === "object" && (r.kind === "order" || r.kind === "price_query") ? { type: "shop", read: r as ReadResult } : null
  }
  if (p && typeof p === "object" && p.type === "quantity") {
    return typeof p.board === "string" && EXAM_BOARDS.includes(p.board) ? { type: "quantity", board: p.board as ExamBoardWord } : null
  }
  if (p && typeof p === "object" && p.type === "amount") {
    if (p.network === undefined || p.network === null) return { type: "amount", network: null }
    return typeof p.network === "string" && AIRTIME_NETWORKS.includes(p.network) ? { type: "amount", network: p.network as AirtimeNetwork } : null
  }
  return p && typeof p === "object" && (p.type === "choices" || p.type === "confirm") ? (p as Pending) : null
}

const EXAM_BOARDS: readonly string[] = ["WASSCE", "BECE", "NOVDEC"]
const AIRTIME_NETWORKS: readonly string[] = ["MTN", "Telecel", "AT"]

/** The three stored shapes. A row with no `service` is a Stage 1 data row; an unknown `service` is dropped. */
function parseLastOrder(x: unknown): LastOrder | null {
  const o = x as { service?: unknown; sizeMb?: unknown; amountGhs?: unknown; network?: unknown; recipient?: unknown; board?: unknown; quantity?: unknown; shopCodeId?: unknown } | null
  if (!o || typeof o !== "object") return null
  if (o.service === undefined) {
    return typeof o.sizeMb === "number" && typeof o.network === "string" && typeof o.recipient === "string"
      ? { sizeMb: o.sizeMb, network: o.network, recipient: o.recipient, ...(typeof o.shopCodeId === "string" ? { shopCodeId: o.shopCodeId } : {}) }
      : null
  }
  if (o.service === "airtime") {
    return typeof o.amountGhs === "number" && Number.isFinite(o.amountGhs) && o.amountGhs > 0 && typeof o.network === "string" && typeof o.recipient === "string"
      ? { service: "airtime", amountGhs: o.amountGhs, network: o.network, recipient: o.recipient }
      : null
  }
  if (o.service === "results_checker") {
    return typeof o.board === "string" && EXAM_BOARDS.includes(o.board) && typeof o.quantity === "number" && Number.isInteger(o.quantity) && o.quantity > 0
      ? { service: "results_checker", board: o.board as ExamBoardWord, quantity: o.quantity }
      : null
  }
  return null
}

/** An expired conversation comes back with empty turns and no pending question; lastOrder is kept (for "again"). */
export async function loadConversation(db: SupabaseClient, line: Line, sender: string, now: Date): Promise<Conversation> {
  const { data, error } = await db
    .from("ttb_conversations")
    .select("turns, pending, last_order, expires_at")
    .eq("line", line)
    .eq("sender", sender)
    .maybeSingle()
  if (error) throw new TtbStoreError("could not read a conversation")
  if (!data) return { ...EMPTY }
  const row = data as { turns?: unknown; pending?: unknown; last_order?: unknown; expires_at?: unknown }
  const lastOrder = parseLastOrder(row.last_order)
  const live = typeof row.expires_at === "string" && Date.parse(row.expires_at) > now.getTime()
  if (!live) return { turns: [], pending: null, lastOrder }
  return { turns: parseTurns(row.turns), pending: parsePending(row.pending), lastOrder }
}

/** expires_at = now + 20 minutes; only the last 6 turns are kept. */
export async function saveConversation(db: SupabaseClient, line: Line, sender: string, c: Conversation, now: Date): Promise<void> {
  const { error } = await db.from("ttb_conversations").upsert(
    {
      line,
      sender,
      turns: c.turns.slice(-MAX_TURNS),
      pending: c.pending,
      last_order: c.lastOrder,
      expires_at: new Date(now.getTime() + CONVERSATION_TTL_MS).toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: "line,sender" },
  )
  if (error) throw new TtbStoreError("could not save a conversation")
}

/** Besides the two lines the table holds the notifier's bookkeeping rows: when the purge and the quiet-line alert last ran. */
export type HeartbeatLine = Line | "purge" | "quiet_alert" | "quiet_alert_shop"

export async function touchHeartbeat(db: SupabaseClient, line: HeartbeatLine, now: Date): Promise<void> {
  const { error } = await db.from("ttb_heartbeat").upsert({ line, last_seen_at: now.toISOString() }, { onConflict: "line" })
  if (error) throw new TtbStoreError("could not record the heartbeat")
}

export async function getHeartbeat(db: SupabaseClient, line: HeartbeatLine): Promise<Date | null> {
  const { data, error } = await db.from("ttb_heartbeat").select("last_seen_at").eq("line", line).maybeSingle()
  if (error) throw new TtbStoreError("could not read the heartbeat")
  const at = (data as { last_seen_at?: unknown } | null)?.last_seen_at
  const t = typeof at === "string" ? Date.parse(at) : NaN
  return Number.isNaN(t) ? null : new Date(t)
}

/** ttb_purge: deletes old messages and expired conversations; returns the number of rows deleted. */
export async function purgeOld(db: SupabaseClient, before: Date): Promise<number> {
  const { data, error } = await db.rpc("ttb_purge", { p_before: before.toISOString() })
  if (error || typeof data !== "number" || !Number.isFinite(data)) throw new TtbStoreError("could not purge old data")
  return data
}

/** The link already written for this order id, or null. */
export async function linkByOrderId(db: SupabaseClient, orderId: string): Promise<{ id: string } | null> {
  const { data, error } = await db.from("ttb_orders").select("id").eq("order_id", orderId).maybeSingle()
  if (error) throw new TtbStoreError("could not look up a link by order")
  const id = (data as { id?: string } | null)?.id
  return id ? { id } : null
}

/**
 * Closes this sender's awaiting_payment links created before windowStart, so the one-open-order index only ever holds a
 * live link. Returns how many were closed.
 */
export async function closeStaleLinks(db: SupabaseClient, line: Line, sender: string, windowStart: Date, now: Date): Promise<number> {
  const { data, error } = await db
    .from("ttb_orders")
    .update({ state: "closed", closed_at: now.toISOString() })
    .eq("line", line)
    .eq("sender", sender)
    .eq("state", "awaiting_payment")
    .lt("created_at", windowStart.toISOString())
    .select("id")
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not close stale links")
  return data.length
}

/** The outcome recorded on an inbound row, or null when it has none yet (or the row is missing). */
export async function getInboundOutcome(db: SupabaseClient, id: string): Promise<string | null> {
  const { data, error } = await db.from("ttb_messages").select("outcome").eq("id", id).maybeSingle()
  if (error) throw new TtbStoreError("could not read an inbound outcome")
  const outcome = (data as { outcome?: unknown } | null)?.outcome
  return typeof outcome === "string" ? outcome : null
}

/** service and orderTable are raw strings on purpose: the notifier decides what it knows. A null (fakes only) is the database default. */
const serviceOf = (r: Record<string, unknown>) => (typeof r.service === "string" ? r.service : "data")
const orderTableOf = (r: Record<string, unknown>) => (typeof r.order_table === "string" ? r.order_table : "ussd_orders")

export type OrderLink = {
  id: string
  orderId: string
  service: string
  orderTable: string
  state: string
  size: string
  recipient: string
  notices: string[]
  createdAt: string
}

/** The sender's newest link on this line (any state), or null. */
export async function latestOrderLink(db: SupabaseClient, line: Line, sender: string): Promise<OrderLink | null> {
  const { data, error } = await db
    .from("ttb_orders")
    .select("id, order_id, service, order_table, state, size, recipient, notices, created_at")
    .eq("line", line)
    .eq("sender", sender)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new TtbStoreError("could not read the latest link")
  const r = data as Record<string, unknown> | null
  if (!r || typeof r.id !== "string") return null
  return {
    id: r.id,
    orderId: String(r.order_id),
    service: serviceOf(r),
    orderTable: orderTableOf(r),
    state: String(r.state),
    size: String(r.size),
    recipient: String(r.recipient),
    notices: Array.isArray(r.notices) ? r.notices.filter((n): n is string => typeof n === "string") : [],
    createdAt: String(r.created_at),
  }
}

export type OrderRow = { paymentStatus: string; orderStatus: string; amount: number }

// ussd_orders names its columns order_status / payment_status / amount; the airtime and results-checker tables use status /
// payment_status / total_paid (the number actually charged).
const ORDER_COLUMNS: Record<OrderTable, { status: string; amount: string }> = {
  ussd_orders: { status: "order_status", amount: "amount" },
  airtime_orders: { status: "status", amount: "total_paid" },
  results_checker_orders: { status: "status", amount: "total_paid" },
  ussd_shop_orders: { status: "order_status", amount: "amount" }, // same status columns as ussd_orders
}

/** The order row's two status columns and the amount charged, or null when the row is gone. Throws TtbStoreError on a read error. */
export async function orderRowFor(db: SupabaseClient, table: OrderTable, orderId: string): Promise<OrderRow | null> {
  const cols = ORDER_COLUMNS[table]
  const { data, error } = await db.from(table).select(`${cols.status}, payment_status, ${cols.amount}`).eq("id", orderId).maybeSingle()
  if (error) throw new TtbStoreError("could not read an order")
  const r = data as Record<string, unknown> | null
  return r ? { orderStatus: String(r[cols.status]), paymentStatus: String(r.payment_status), amount: Number(r[cols.amount]) } : null
}

/**
 * Takes the processing lease on an inbound row: one guarded UPDATE, true only when exactly this call set claimed_at.
 * A row that already has an outcome is never claimed; a lease older than leaseSeconds (a crashed run) can be taken again.
 */
export async function claimInbound(db: SupabaseClient, id: string, now: Date, leaseSeconds = 60): Promise<boolean> {
  const expired = new Date(now.getTime() - leaseSeconds * 1000).toISOString()
  const { data, error } = await db
    .from("ttb_messages")
    .update({ claimed_at: now.toISOString() })
    .eq("id", id)
    .is("outcome", null)
    .or(`claimed_at.is.null,claimed_at.lt.${expired}`)
    .select("id")
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not claim an inbound message")
  return data.length === 1
}

export type WatchedLink = {
  id: string
  line: Line
  sender: string
  orderId: string
  service: string
  orderTable: string
  state: string
  size: string
  recipient: string
  gift: boolean
  amount: number
  notices: string[]
  createdAt: string
  paidAt: string | null
  deliveredAt: string | null
  /** The shop a shop-line order was placed for; null on the main line (and on a shop row that somehow lacks it). */
  shopId: string | null
}

const WATCH_COLUMNS = "id, line, sender, order_id, service, order_table, state, size, recipient, gift, amount, notices, created_at, paid_at, delivered_at, shop_id"
const LATE_APPROVAL_MS = 48 * 60 * 60_000

function toWatched(r: Record<string, unknown>): WatchedLink {
  return {
    id: String(r.id),
    line: r.line === "shop" ? "shop" : "main",
    sender: String(r.sender),
    orderId: String(r.order_id),
    service: serviceOf(r),
    orderTable: orderTableOf(r),
    state: String(r.state),
    size: String(r.size),
    recipient: String(r.recipient),
    gift: r.gift === true,
    amount: Number(r.amount),
    notices: Array.isArray(r.notices) ? r.notices.filter((n): n is string => typeof n === "string") : [],
    createdAt: String(r.created_at),
    paidAt: typeof r.paid_at === "string" ? r.paid_at : null,
    deliveredAt: typeof r.delivered_at === "string" ? r.delivered_at : null,
    shopId: typeof r.shop_id === "string" && r.shop_id ? r.shop_id : null,
  }
}

/**
 * The links the notifier follows: awaiting_payment and paid ones (oldest first, at most `limit`), plus links closed within the
 * last 48 hours that never got a paid_at (a late approval can still turn them paid). Never closed-and-paid ones.
 */
export async function watchedLinks(db: SupabaseClient, now: Date, limit = 200): Promise<WatchedLink[]> {
  const open = await db.from("ttb_orders").select(WATCH_COLUMNS).in("state", ["awaiting_payment", "paid"]).order("created_at", { ascending: true }).limit(limit)
  if (open.error || !Array.isArray(open.data)) throw new TtbStoreError("could not read open links")
  const since = new Date(now.getTime() - LATE_APPROVAL_MS).toISOString()
  const late = await db
    .from("ttb_orders")
    .select(WATCH_COLUMNS)
    .eq("state", "closed")
    .gte("closed_at", since)
    .is("paid_at", null)
    .order("created_at", { ascending: true })
    .limit(limit)
  if (late.error || !Array.isArray(late.data)) throw new TtbStoreError("could not read recently closed links")
  return [...open.data, ...late.data].map((r) => toWatched(r as Record<string, unknown>))
}

/**
 * Records a notice atomically through ttb_add_notice (array_append guarded by `NOT (key = ANY(notices))`, in one UPDATE).
 * True only when THIS call added the key, so two overlapping runs cannot both send and a different key is never lost.
 * The caller sends only on true. `_current` is kept for the call sites; the database is the source of truth.
 */
export async function addNotice(db: SupabaseClient, linkId: string, _current: string[], key: string): Promise<boolean> {
  const { data, error } = await db.rpc("ttb_add_notice", { p_id: linkId, p_key: key })
  if (error || typeof data !== "boolean") throw new TtbStoreError("could not record a notice")
  return data
}

/** Updates a link only while it is still in one of the given states. True when a row changed. */
export async function patchLink(
  db: SupabaseClient,
  linkId: string,
  patch: { state?: "awaiting_payment" | "paid" | "closed"; paid_at?: string; delivered_at?: string; closed_at?: string },
  fromStates: string[],
): Promise<boolean> {
  const { data, error } = await db.from("ttb_orders").update(patch).eq("id", linkId).in("state", fromStates).select("id")
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not update a link")
  return data.length === 1
}

export type StrandedInbound = { id: string; line: Line; sender: string; body: string; receivedAt: Date | null }

/** How old an unprocessed inbound row may be and still be recovered by the sweep. Past this it is never re-run. */
export const STRANDED_MAX_AGE_MS = 15 * 60_000

/**
 * Inbound rows with no outcome that are between 90 seconds and 15 minutes old: a crash mid-processing. Oldest first.
 * `lines`, when given, limits the read to those lines (a line whose switch is off is not recovered).
 */
export async function strandedInbound(db: SupabaseClient, now: Date, limit = 20, lines?: Line[]): Promise<StrandedInbound[]> {
  const newest = new Date(now.getTime() - 90_000).toISOString()
  const oldest = new Date(now.getTime() - STRANDED_MAX_AGE_MS).toISOString()
  let query = db
    .from("ttb_messages")
    .select("id, line, sender, body, received_at")
    .eq("direction", "in")
    .is("outcome", null)
    .gte("created_at", oldest)
    .lt("created_at", newest)
  if (lines) query = query.in("line", lines)
  const { data, error } = await query.order("created_at", { ascending: true }).limit(limit)
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not read stranded messages")
  return data.map((r) => {
    const x = r as Record<string, unknown>
    const t = typeof x.received_at === "string" ? Date.parse(x.received_at) : NaN
    return { id: String(x.id), line: x.line === "shop" ? "shop" : "main", sender: String(x.sender), body: String(x.body), receivedAt: Number.isNaN(t) ? null : new Date(t) }
  })
}

/**
 * The INBOUND message id a shop order's credit reserve is keyed by: the text that placed the order carries the link id
 * (setInboundResult orderLinkId). Null when no such text is recorded. The sender and line narrow the read to an indexed range.
 */
export async function reserveMessageIdForLink(db: SupabaseClient, link: { id: string; line: Line; sender: string }): Promise<string | null> {
  const { data, error } = await db
    .from("ttb_messages")
    .select("id")
    .eq("line", link.line)
    .eq("sender", link.sender)
    .eq("direction", "in")
    .eq("order_link_id", link.id)
    .limit(1)
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not read a reserve key")
  const id = (data[0] as { id?: unknown } | undefined)?.id
  return typeof id === "string" ? id : null
}

/** An unreleased credit reserve and the order link its text placed (null when the text never got one). Ids only. */
export type StaleReserve = { messageId: string; shopId: string; linkId: string | null; linkState: string | null }

/**
 * Unreleased shop credit reserves created between `maxAgeMs` and `olderThanMs` ago, oldest first, with the link each one belongs
 * to. ttb_credit_reserves is SELECT-only for service_role (rows change through the ttb_*_reserve functions). The upper age bound
 * keeps a reserve that can never be refunded (its account is gone) from being retried forever.
 *
 * Returns only ACTIONABLE reserves: not already marked for a retry backoff today (RESERVE_RETRY_KIND, see below) and not owned by
 * a link that is still open (an open order releases its own reserve). The read pages oldest-first on created_at (keyset, at most
 * `maxPages` pages of `pageSize`) until `limit` actionable ones are found, so reserves that are skipped never fill the window.
 */
export async function staleReserves(
  db: SupabaseClient,
  now: Date,
  o: { olderThanMs: number; maxAgeMs: number; limit: number; pageSize: number; maxPages: number; day: string },
): Promise<StaleReserve[]> {
  const newest = new Date(now.getTime() - o.olderThanMs).toISOString()
  const oldest = new Date(now.getTime() - o.maxAgeMs).toISOString()
  const out: StaleReserve[] = []
  let cursor: string | null = null
  for (let page = 0; page < o.maxPages && out.length < o.limit; page++) {
    let q = db
      .from("ttb_credit_reserves")
      .select("message_id, shop_id, created_at")
      .is("released_at", null)
      .lt("created_at", newest)
      .gte("created_at", oldest)
    if (cursor) q = q.gt("created_at", cursor)
    const res = await q.order("created_at", { ascending: true }).limit(o.pageSize)
    if (res.error || !Array.isArray(res.data)) throw new TtbStoreError("could not read stale reserves")
    const rows = res.data.map((r) => r as Record<string, unknown>)
    const last = rows[rows.length - 1]?.created_at
    out.push(...(await actionable(db, rows.filter((r) => typeof r.message_id === "string" && typeof r.shop_id === "string"), o.day)))
    if (rows.length < o.pageSize || typeof last !== "string") break
    cursor = last
  }
  return out.slice(0, o.limit)
}

/**
 * Backoff marker for a dead reserve: a ttb_notices row (ttb_notice_once) of this kind, with sender "reserve", the INBOUND message
 * id (a uuid, like the reserve's own key) in the shop_id key position and the day. One row per reserve per day.
 */
export const RESERVE_RETRY_KIND = "reserve_retry"

/** Records that a release of this reserve failed today, so later runs the same day skip it. Fixed key, no PII. */
export function markReserveRetry(db: SupabaseClient, messageId: string, day: string): Promise<boolean> {
  return noticeOnce(db, RESERVE_RETRY_KIND, "reserve", messageId, day)
}

async function actionable(db: SupabaseClient, reserves: Record<string, unknown>[], day: string): Promise<StaleReserve[]> {
  if (reserves.length === 0) return []
  const marks = await db
    .from("ttb_notices")
    .select("shop_id")
    .eq("kind", RESERVE_RETRY_KIND)
    .eq("day", day)
    .in("shop_id", reserves.map((r) => r.message_id as string))
  if (marks.error || !Array.isArray(marks.data)) throw new TtbStoreError("could not read reserve backoff")
  const marked = new Set((marks.data as Record<string, unknown>[]).map((m) => m.shop_id))
  reserves = reserves.filter((r) => !marked.has(r.message_id))
  if (reserves.length === 0) return []

  const msgs = await db.from("ttb_messages").select("id, order_link_id").in("id", reserves.map((r) => r.message_id as string))
  if (msgs.error || !Array.isArray(msgs.data)) throw new TtbStoreError("could not read reserve messages")
  const linkOf = new Map<string, string>()
  for (const m of msgs.data as Record<string, unknown>[]) if (typeof m.id === "string" && typeof m.order_link_id === "string") linkOf.set(m.id, m.order_link_id)

  const linkIds = [...new Set(linkOf.values())]
  const stateOf = new Map<string, string>()
  if (linkIds.length > 0) {
    const links = await db.from("ttb_orders").select("id, state").in("id", linkIds)
    if (links.error || !Array.isArray(links.data)) throw new TtbStoreError("could not read reserve links")
    for (const l of links.data as Record<string, unknown>[]) if (typeof l.id === "string") stateOf.set(l.id, String(l.state))
  }
  return reserves
    .map((r) => {
      const linkId = linkOf.get(r.message_id as string) ?? null
      return { messageId: r.message_id as string, shopId: r.shop_id as string, linkId, linkState: linkId ? stateOf.get(linkId) ?? null : null }
    })
    .filter((r) => r.linkId === null || r.linkState === "closed") // an open (or unknown) order owns its reserve
}

// ---- Admin API (task 13) -------------------------------------------------------------------------------------------------

/** Adds or updates a block. blocked_by is the admin's user id. */
export async function blockSender(db: SupabaseClient, sender: string, reason: string | null, adminId: string): Promise<void> {
  const { error } = await db.from("ttb_blocked").upsert({ sender, reason, blocked_by: adminId }, { onConflict: "sender" })
  if (error) throw new TtbStoreError("could not block a sender")
}

/** True when a block was removed (service_role may delete from ttb_blocked, see migration 0177). */
export async function unblockSender(db: SupabaseClient, sender: string): Promise<boolean> {
  const { data, error } = await db.from("ttb_blocked").delete().eq("sender", sender).select("sender")
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not unblock a sender")
  return data.length > 0
}

/** Flags an INBOUND row as misread by the bot. False when the id is not an inbound row. */
export async function markMisread(db: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await db.from("ttb_messages").update({ misread: true }).eq("id", id).eq("direction", "in").select("id")
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not flag a message")
  return data.length > 0
}

/**
 * Inbound rows newest first, keyset paged on (created_at desc, id desc). The cursor timestamp is spliced into an or() filter,
 * so decodeCursor only ever hands over a strictly validated one.
 */
export async function listInbound(
  db: SupabaseClient,
  q: { limit: number; line?: Line; sender?: string; outcome?: Outcome; cursor?: { createdAt: string; id: string } },
): Promise<{ rows: AdminMessage[]; nextCursor: string | null }> {
  let query = db.from("ttb_messages").select(MESSAGE_COLUMNS).eq("direction", "in")
  if (q.line) query = query.eq("line", q.line)
  if (q.sender) query = query.eq("sender", q.sender)
  if (q.outcome) query = query.eq("outcome", q.outcome)
  if (q.cursor) {
    const at = q.cursor.createdAt.replace("+00:00", "Z")
    query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${q.cursor.id})`)
  }
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(q.limit + 1)
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not read messages")
  const page = data.slice(0, q.limit).map((r) => toAdminMessage(r as Record<string, unknown>))
  const last = page[page.length - 1]
  return { rows: page, nextCursor: data.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null }
}

const THREAD_CAP = 200

/** Both directions for one sender, oldest first; the latest 200 when there are more. */
export async function listThread(db: SupabaseClient, sender: string, line?: Line): Promise<AdminMessage[]> {
  let query = db.from("ttb_messages").select(MESSAGE_COLUMNS).eq("sender", sender)
  if (line) query = query.eq("line", line)
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(THREAD_CAP)
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not read a thread")
  return data.map((r) => toAdminMessage(r as Record<string, unknown>)).reverse()
}

/** ttb_overview: one row per line, both always present, counted since `from`. */
export async function overviewRows(db: SupabaseClient, from: Date): Promise<OverviewRow[]> {
  const { data, error } = await db.rpc("ttb_overview", { p_from: from.toISOString() })
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not read the overview")
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0)
  return data.map((r) => {
    const x = r as Record<string, unknown>
    return {
      line: x.line === "shop" ? "shop" : "main",
      texts: n(x.texts), prompts: n(x.prompts), paid: n(x.paid), delivered: n(x.delivered),
      replies: n(x.replies), aiReads: n(x.ai_reads), ruleReads: n(x.rule_reads),
    }
  })
}

const SERVICES: Service[] = ["data", "airtime", "results_checker"]

/**
 * One line's links created since `from`, per service: prompts = links, paid = paid_at set, delivered = delivered_at set.
 * Count queries only (head: true); no database function.
 */
export async function serviceCounts(db: SupabaseClient, line: Line, from: Date): Promise<Record<Service, { prompts: number; paid: number; delivered: number }>> {
  const count = async (service: Service, notNull?: "paid_at" | "delivered_at"): Promise<number> => {
    let q = db.from("ttb_orders").select("id", { count: "exact", head: true }).eq("line", line).eq("service", service).gte("created_at", from.toISOString())
    if (notNull) q = q.not(notNull, "is", null)
    const { count: n, error } = await q
    if (error || typeof n !== "number") throw new TtbStoreError("could not read the service counts")
    return n
  }
  const rows = await Promise.all(SERVICES.map(async (s) => [s, { prompts: await count(s), paid: await count(s, "paid_at"), delivered: await count(s, "delivered_at") }] as const))
  return Object.fromEntries(rows) as Record<Service, { prompts: number; paid: number; delivered: number }>
}

/** The main line's counts (the Stage 1 admin overview): serviceCounts with the line named explicitly. */
export function serviceCountsToday(db: SupabaseClient, from: Date): Promise<Record<Service, { prompts: number; paid: number; delivered: number }>> {
  return serviceCounts(db, "main", from)
}

// ---- Shop line (Stage 3a, migration 0180) ---------------------------------------------------------------------------------

/** The shop this sender last used on the shop line, or null. */
export async function getShopPref(db: SupabaseClient, sender: string): Promise<{ shopCodeId: string } | null> {
  const { data, error } = await db.from("ttb_shop_prefs").select("shop_code_id").eq("sender", sender).maybeSingle()
  if (error) throw new TtbStoreError("could not read a shop preference")
  const id = (data as { shop_code_id?: unknown } | null)?.shop_code_id
  return typeof id === "string" ? { shopCodeId: id } : null
}

/** Remembers the shop (one row per sender). */
export async function setShopPref(db: SupabaseClient, sender: string, shopCodeId: string): Promise<void> {
  const { error } = await db
    .from("ttb_shop_prefs")
    .upsert({ sender, shop_code_id: shopCodeId, last_used_at: new Date().toISOString() }, { onConflict: "sender" })
  if (error) throw new TtbStoreError("could not save a shop preference")
}

/**
 * ussd_shop_orders.dialing_phone is written as the channel gave it: +233... (Uzo, Hubtel), and the WhatsApp shop bot
 * passes the sender id through (233... without the plus); older rows may be local 0XXXXXXXXX. Match all three.
 */
const dialingForms = (local: string) => {
  const sig = local.replace(/^0/, "")
  return [`+233${sig}`, `233${sig}`, `0${sig}`]
}
// order_status values that mean the customer did not get the bundle (refund sets 'refunded'; 'refunding' is mid-refund).
const NOT_BOUGHT = new Set(["failed", "refunded", "refunding", "reversed"])

/**
 * The shop code of this phone's newest bought order: payment completed and the order not failed, refunded or reversed.
 * Null when there is none. Looks at the 20 newest paid rows of the phone; the status test runs here so the list can grow.
 */
export async function lastBoughtShopCodeId(db: SupabaseClient, senderLocal: string): Promise<string | null> {
  const { data, error } = await db
    .from("ussd_shop_orders")
    .select("shop_code_id, order_status, payment_status")
    .in("dialing_phone", dialingForms(senderLocal))
    .eq("payment_status", "completed")
    .order("created_at", { ascending: false })
    .limit(20)
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not read the last shop order")
  for (const r of data as Record<string, unknown>[]) {
    if (typeof r.shop_code_id === "string" && !NOT_BOUGHT.has(String(r.order_status))) return r.shop_code_id
  }
  return null
}

/** True when THIS call created the (kind, sender, shop, day) notice row (ttb_notice_once); false on a repeat. day is YYYY-MM-DD. */
export async function noticeOnce(db: SupabaseClient, kind: string, sender: string, shopId: string | null, day: string): Promise<boolean> {
  const { data, error } = await db.rpc("ttb_notice_once", { p_kind: kind, p_sender: sender, p_shop: shopId, p_day: day })
  if (error || typeof data !== "boolean") throw new TtbStoreError("could not record a notice")
  return data
}

/**
 * Shops that were paused today (a "paused" notice row for the day, one per shop and customer): shop id, display name, count.
 * Never selects or returns a sender. day is YYYY-MM-DD. Capped at 50 shops (most notices first).
 */
export async function pausedShopsToday(db: SupabaseClient, day: string): Promise<PausedShop[]> {
  const n = await db.from("ttb_notices").select("shop_id").eq("kind", "paused").eq("day", day).limit(5000)
  if (n.error || !Array.isArray(n.data)) throw new TtbStoreError("could not read the paused shops")
  const notices = n.data as { shop_id: unknown }[]
  const ids = [...new Set(notices.map((r) => r.shop_id).filter((x): x is string => typeof x === "string"))].slice(0, 200)
  if (ids.length === 0) return []
  const s = await db.from("user_shops").select("id, shop_name, ussd_display_name").in("id", ids)
  if (s.error || !Array.isArray(s.data)) throw new TtbStoreError("could not read the shop names")
  return shapePausedShops(notices.filter((r) => typeof r.shop_id === "string" && ids.includes(r.shop_id)), s.data as { id: unknown }[]).slice(0, 50)
}

/** Writes the given admin_settings keys as { "value": x } in ONE upsert statement. An empty set writes nothing. */
export async function saveSettingRows(db: SupabaseClient, values: Record<string, unknown>, adminId: string, now: Date): Promise<void> {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value: { value }, updated_by: adminId, updated_at: now.toISOString() }))
  if (rows.length === 0) return
  const { error } = await db.from("admin_settings").upsert(rows, { onConflict: "key" })
  if (error) throw new TtbStoreError("could not save settings")
}
