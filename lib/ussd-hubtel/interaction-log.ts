// lib/ussd-hubtel/interaction-log.ts
// Transcript of Hubtel USSD sessions (table hubtel_ussd_interactions, migration 0126): one row per
// request and our reply, so admins and shop owners can read a session like Hubtel's dashboard.
// Best-effort like callback-log.ts: never throws, never changes a reply, bounded in time, and
// silent (one warning per process) until the migration is applied.
import type { SupabaseClient } from "@supabase/supabase-js"
import { isCallbackLogTableMissing } from "./callback-log"
import type { HubtelSessionStore } from "./session"
import { safeDbError } from "./log-safe"
import type { HubtelReply, HubtelRequest, HubtelSession } from "./types"

export const INTERACTION_LOG_TABLE = "hubtel_ussd_interactions"
export const INTERACTION_LOG_RETENTION_DAYS = 30
/** Caps per text column: a USSD screen is ~182 chars; app/web screens can be longer. */
const TEXT_CAP = 2_000
const WRITE_TIMEOUT_MS = 3_000

export interface InteractionRow {
  created_at: string
  session_id: string
  seq: number | null
  mobile: string | null
  platform: string | null
  request_type: string | null
  input: string | null
  reply_type: string | null
  reply: string | null
  step: string | null
  mode: string | null
  shop_id: string | null
}

const cap = (s: string | null | undefined) => (s == null ? null : s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) : s)

/** The row for one exchange. `session` is the session as it stands after the reply (null once ended). */
export function shapeInteractionRow(
  req: HubtelRequest, reply: HubtelReply | null, session: HubtelSession | null, at: Date
): InteractionRow {
  return {
    created_at: at.toISOString(),
    session_id: req.SessionId,
    seq: Number.isFinite(req.Sequence) ? req.Sequence : null,
    mobile: req.Mobile || null,
    platform: req.Platform || null,
    request_type: req.Type,
    input: cap(req.Message),
    reply_type: reply?.Type ?? null,
    reply: cap(reply?.Message ?? null),
    step: reply?.ClientState || session?.step || null,
    mode: session?.mode ?? null,
    shop_id: session?.shopId ?? null,
  }
}

/**
 * Wraps the session store for ONE request and remembers the latest session read or written, so
 * the log row knows the shop (set by the code step) even when the session is deleted later.
 */
export function trackSessionStore(inner: HubtelSessionStore): { store: HubtelSessionStore; latest(): HubtelSession | null } {
  let last: HubtelSession | null = null
  return {
    latest: () => last,
    store: {
      async get(id) { const s = await inner.get(id); if (s) last = s; return s },
      async set(id, s) { last = s; await inner.set(id, s) },
      async del(id) { await inner.del(id) }, // keep `last`: the row still belongs to that shop
    },
  }
}

let missingWarned = false
export function __resetInteractionLogWarningsForTests(): void { missingWarned = false }

function report(what: string, err: unknown): void {
  if (isCallbackLogTableMissing(err)) {
    if (!missingWarned) {
      missingWarned = true
      console.warn(`[HUBTEL-USSD-LOG] ${INTERACTION_LOG_TABLE} missing (apply migration 0126); transcripts are off until then`)
    }
    return
  }
  console.error(`[HUBTEL-USSD-LOG] ${what} failed:`, safeDbError(err))
}

async function bounded(builder: unknown): Promise<{ error?: unknown } | "timeout"> {
  const b = builder as { abortSignal?: (s: AbortSignal) => unknown }
  const q = typeof b?.abortSignal === "function" ? b.abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS)) : builder
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), WRITE_TIMEOUT_MS) })
  try {
    return await Promise.race([Promise.resolve(q as PromiseLike<{ error?: unknown }>), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Inserts one transcript row. Never throws or rejects; never takes longer than ~3s. */
export async function logInteraction(supabase: SupabaseClient, row: InteractionRow): Promise<void> {
  try {
    const r = await bounded(supabase.from(INTERACTION_LOG_TABLE).insert(row))
    if (r === "timeout") { console.warn(`[HUBTEL-USSD-LOG] insert timed out after ${WRITE_TIMEOUT_MS}ms; row dropped`); return }
    if (r?.error) report("insert", r.error)
  } catch (e) {
    report("insert", e)
  }
}

/** 30-day retention. Best-effort, never throws. */
export async function purgeOldInteractions(supabase: SupabaseClient, days = INTERACTION_LOG_RETENTION_DAYS, now = Date.now()): Promise<void> {
  try {
    const cutoff = new Date(now - days * 86_400_000).toISOString()
    const r = await bounded(supabase.from(INTERACTION_LOG_TABLE).delete().lt("created_at", cutoff))
    if (r === "timeout") return
    if (r?.error) report("purge", r.error)
  } catch (e) {
    report("purge", e)
  }
}

// ---- Readers (admin + shop owner viewers) ----

export interface SessionSummary {
  session_id: string
  mobile: string | null
  shop_id: string | null
  mode: string | null
  started_at: string
  ended_at: string
  exchanges: number
  last_reply_type: string | null
  last_request_type: string | null
  payment_state: string | null
  amount: number | null
}

/** "Paid", "Awaiting payment", "Timed out", ... for a summary row. */
export function sessionOutcome(s: Pick<SessionSummary, "payment_state" | "last_reply_type" | "last_request_type">): string {
  switch (s.payment_state) {
    case "fulfilled": return "Paid - delivered"
    case "processing": return "Paid - processing"
    case "needs_review": return "Paid - needs review"
    case "failed": return "Payment failed"
    case "awaiting_payment": return "Awaiting payment"
  }
  if (s.last_request_type === "Timeout") return "Timed out"
  if (s.last_reply_type === "release") return "Ended"
  return "Abandoned"
}

export const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

export async function listSessionSummaries(
  supabase: SupabaseClient, opts: { shopId: string | null; before: string | null; limit: number }
): Promise<{ ok: true; sessions: SessionSummary[] } | { ok: false; missing: boolean; error: string }> {
  const { data, error } = await supabase.rpc("hubtel_ussd_session_summaries", {
    p_shop_id: opts.shopId, p_before: opts.before, p_limit: opts.limit,
  })
  if (error) {
    const missing = isCallbackLogTableMissing(error) || (error as { code?: string }).code === "PGRST202" || (error as { code?: string }).code === "42883"
    if (!missing) console.error("[HUBTEL-USSD-LOG] summaries failed:", safeDbError(error))
    return { ok: false, missing, error: missing ? "Session log not set up yet (apply migration 0126)" : "Failed to load sessions" }
  }
  return {
    ok: true,
    sessions: ((data ?? []) as SessionSummary[]).map(s => ({ ...s, amount: s.amount == null ? null : Number(s.amount) })),
  }
}

export interface TranscriptRow {
  created_at: string
  seq: number | null
  request_type: string | null
  input: string | null
  reply_type: string | null
  reply: string | null
  shop_id: string | null
}

/** The full transcript, oldest first. With `shopId`, only if that shop's code was used in the session. */
export async function getTranscript(
  supabase: SupabaseClient, sessionId: string, shopId: string | null
): Promise<{ ok: true; rows: TranscriptRow[] } | { ok: false; status: number; error: string }> {
  const { data, error } = await supabase
    .from(INTERACTION_LOG_TABLE)
    .select("created_at, seq, request_type, input, reply_type, reply, shop_id")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(200)
  if (error) {
    if (!isCallbackLogTableMissing(error)) console.error("[HUBTEL-USSD-LOG] transcript failed:", safeDbError(error))
    return { ok: false, status: 500, error: "Failed to load transcript" }
  }
  const rows = (data ?? []) as TranscriptRow[]
  if (rows.length === 0) return { ok: false, status: 404, error: "Session not found" }
  if (shopId && !rows.some(r => r.shop_id === shopId)) return { ok: false, status: 404, error: "Session not found" }
  return { ok: true, rows }
}
