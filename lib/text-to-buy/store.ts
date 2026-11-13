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
 * Links a placed order to its sender. "conflict" means the one-open-order index (or the order id) already holds a row:
 * a concurrent text won, and the caller closes the order it just placed.
 */
export async function linkOrder(
  db: SupabaseClient,
  o: { line: Line; sender: string; orderId: string; size: string; recipient: string; gift: boolean; amount: number },
): Promise<{ id: string } | "conflict"> {
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
  if (isUnique(error)) return "conflict"
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
