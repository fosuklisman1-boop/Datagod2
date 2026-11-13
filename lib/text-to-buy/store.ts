import { createHash } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Line, Outcome, ReadResult } from "./types"

/**
 * Text-to-Buy database access (tables and functions of migration 0163). Server-only, service-role client.
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

// Constraint names from migration 0163 (a PGlite test pins that they exist).
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
  m: { line: Line; sender: string; body: string; receivedAt: Date | null; now: Date },
): Promise<InboundRow> {
  const key = dedupeKey(m.line, m.sender, m.body, m.receivedAt, m.now)
  const ins = await db
    .from("ttb_messages")
    .insert({
      line: m.line,
      sender: m.sender,
      direction: "in",
      body: m.body,
      received_at: m.receivedAt ? m.receivedAt.toISOString() : null,
      dedupe_key: key,
    })
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
  m: { line: Line; sender: string; body: string; orderLinkId?: string },
): Promise<void> {
  const row: Record<string, unknown> = { line: m.line, sender: m.sender, direction: "out", body: m.body }
  if (m.orderLinkId !== undefined) row.order_link_id = m.orderLinkId
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
  o: { line: Line; sender: string; orderId: string; size: string; recipient: string; gift: boolean; amount: number },
): Promise<{ id: string } | { id: string; alreadyLinked: true } | "conflict"> {
  const { data, error } = await db
    .from("ttb_orders")
    .insert({
      line: o.line,
      sender: o.sender,
      order_id: o.orderId,
      size: o.size,
      recipient: o.recipient,
      gift: o.gift,
      amount: o.amount,
    })
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
export type LastOrder = { sizeMb: number; network: string; recipient: string }
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
  const p = x as { type?: unknown } | null
  return p && typeof p === "object" && (p.type === "choices" || p.type === "confirm") ? (p as Pending) : null
}

function parseLastOrder(x: unknown): LastOrder | null {
  const o = x as { sizeMb?: unknown; network?: unknown; recipient?: unknown } | null
  return o && typeof o.sizeMb === "number" && typeof o.network === "string" && typeof o.recipient === "string"
    ? { sizeMb: o.sizeMb, network: o.network, recipient: o.recipient }
    : null
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

export async function touchHeartbeat(db: SupabaseClient, line: Line, now: Date): Promise<void> {
  const { error } = await db.from("ttb_heartbeat").upsert({ line, last_seen_at: now.toISOString() }, { onConflict: "line" })
  if (error) throw new TtbStoreError("could not record the heartbeat")
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

export type OrderLink = {
  id: string
  orderId: string
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
    .select("id, order_id, state, size, recipient, notices, created_at")
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
    state: String(r.state),
    size: String(r.size),
    recipient: String(r.recipient),
    notices: Array.isArray(r.notices) ? r.notices.filter((n): n is string => typeof n === "string") : [],
    createdAt: String(r.created_at),
  }
}

/** The USSD order row's two status columns, or null when it is gone. */
export async function ussdOrderStatus(db: SupabaseClient, orderId: string): Promise<{ orderStatus: string; paymentStatus: string } | null> {
  const { data, error } = await db.from("ussd_orders").select("order_status, payment_status").eq("id", orderId).maybeSingle()
  if (error) throw new TtbStoreError("could not read an order status")
  const r = data as { order_status?: unknown; payment_status?: unknown } | null
  return r ? { orderStatus: String(r.order_status), paymentStatus: String(r.payment_status) } : null
}

/** Fails a USSD order row, guarded on payment_status = 'pending'. True when this call changed the row. */
export async function failPendingUssdOrder(db: SupabaseClient, orderId: string, now: Date): Promise<boolean> {
  const { data, error } = await db
    .from("ussd_orders")
    .update({ order_status: "failed", payment_status: "failed", updated_at: now.toISOString() })
    .eq("id", orderId)
    .eq("payment_status", "pending")
    .select("id")
  if (error || !Array.isArray(data)) throw new TtbStoreError("could not fail a losing order")
  return data.length > 0
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
