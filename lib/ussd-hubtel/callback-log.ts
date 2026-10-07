// lib/ussd-hubtel/callback-log.ts
// Best-effort audit log of Hubtel payment traffic in BOTH directions (table hubtel_callback_logs,
// migration 0109): inbound fulfilment webhooks (Hubtel -> us) and outbound success callbacks
// (us -> relay -> Hubtel). Everything here is fire-and-forget safe: it never throws, never changes
// a caller's result, and is silent (one warning per process) until the migration is applied.
// Never stores URLs, query strings, headers, or secret values.
import type { SupabaseClient } from "@supabase/supabase-js"
import { buildCallbackPayload } from "./relay"
import { safeDbError } from "./log-safe"

export const CALLBACK_LOG_TABLE = "hubtel_callback_logs"

export type CallbackLogDirection = "inbound_fulfillment" | "outbound_callback"

/** Inbound outcomes: the fulfilment route's own failures plus processFulfillment's results. */
export type InboundLogOutcome =
  | "parse_error" | "invalid_payload" | "fulfilled" | "needs_review" | "duplicate" | "unsuccessful" | "unknown_session" | "error"

/** Inbound outcomes that need a human look; logged with ok=false so "Problems only" finds them. */
const INBOUND_PROBLEMS: ReadonlySet<string> = new Set(["parse_error", "invalid_payload", "needs_review", "unknown_session", "error"])
export function inboundOk(outcome: InboundLogOutcome): boolean {
  return !INBOUND_PROBLEMS.has(outcome)
}

export const LOG_CAPS = { payload: 50_000, rawBody: 20_000, response: 5_000, error: 500 } as const

export interface CallbackLogEntry {
  direction: CallbackLogDirection
  sessionId?: string | null
  hubtelOrderId?: string | null
  outcome?: string | null
  ok?: boolean | null
  httpStatus?: number | null
  /** Parsed JSON (inbound body as received, or the outbound body we sent). */
  payload?: unknown
  /** Only when the inbound body did NOT parse as JSON. */
  rawBody?: string | null
  /** Outbound: Hubtel's response body as reported by the relay. */
  response?: unknown
  error?: string | null
  sourceIp?: string | null
}

export interface CallbackLogRow {
  direction: CallbackLogDirection
  session_id: string | null
  hubtel_order_id: string | null
  outcome: string | null
  ok: boolean | null
  http_status: number | null
  payload: unknown
  raw_body: string | null
  response: unknown
  error: string | null
  source_ip: string | null
}

const SECRET_ENV_KEYS = ["HUBTEL_WEBHOOK_SECRET", "HUBTEL_RELAY_SECRET"] as const
const ROW_DETAIL_MARKERS = ["Failing row contains", "Key ("]
const TRUNCATED = "...[truncated]"

/** Removes our secret values and any Bearer token from a piece of text. */
function redactSecrets(text: string): string {
  let out = text
  for (const k of SECRET_ENV_KEYS) {
    const v = process.env[k]
    if (v && v.length >= 4) out = out.split(v).join("[redacted]")
  }
  // Stops at quote/backslash so redacting inside JSON text keeps it valid JSON.
  return out.replace(/Bearer\s+[^\s"'\\,}]+/gi, "Bearer [redacted]")
}

/** JSON value with secrets redacted; null when absent; a marker when too big or unserialisable. */
function shapeJson(value: unknown, cap: number, keepPreview: boolean): unknown {
  if (value === undefined || value === null) return null
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    return { unserialisable: true }
  }
  if (text === undefined) return null
  const size = text.length
  if (size > cap) {
    return keepPreview
      ? { truncated: true, size, preview: redactSecrets(text).slice(0, cap - 100) }
      : { truncated: true, size }
  }
  try {
    return JSON.parse(redactSecrets(text))
  } catch {
    return { unserialisable: true }
  }
}

function capText(text: string, cap: number, suffix: string): string {
  return text.length > cap ? text.slice(0, cap) + suffix : text
}

function sanitiseError(error: string): string {
  let msg = error
  for (const marker of ROW_DETAIL_MARKERS) {
    const i = msg.indexOf(marker)
    if (i >= 0) msg = `${msg.slice(0, i).trimEnd()} [row details redacted]`
  }
  return capText(redactSecrets(msg).trim(), LOG_CAPS.error, "...")
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)

export function shapeCallbackLogRow(entry: CallbackLogEntry): CallbackLogRow {
  return {
    direction: entry.direction,
    session_id: str(entry.sessionId),
    hubtel_order_id: str(entry.hubtelOrderId),
    outcome: str(entry.outcome),
    ok: typeof entry.ok === "boolean" ? entry.ok : null,
    http_status: typeof entry.httpStatus === "number" && Number.isFinite(entry.httpStatus) ? Math.trunc(entry.httpStatus) : null,
    payload: shapeJson(entry.payload, LOG_CAPS.payload, false),
    raw_body: typeof entry.rawBody === "string" ? capText(redactSecrets(entry.rawBody), LOG_CAPS.rawBody, TRUNCATED) : null,
    response: shapeJson(entry.response, LOG_CAPS.response, true),
    error: typeof entry.error === "string" && entry.error ? sanitiseError(entry.error) : null,
    source_ip: str(entry.sourceIp),
  }
}

/** Table not created yet (migration 0109 not applied): Postgres 42P01 or PostgREST PGRST205. */
export function isCallbackLogTableMissing(err: unknown): boolean {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined
  return code === "42P01" || code === "PGRST205"
}

let missingTableWarned = false
/** Test hook: re-arm the once-per-process "table missing" warning. */
export function __resetCallbackLogWarningsForTests(): void {
  missingTableWarned = false
}

function reportFailure(what: string, err: unknown): void {
  if (isCallbackLogTableMissing(err)) {
    if (!missingTableWarned) {
      missingTableWarned = true
      console.warn(`[HUBTEL-CALLBACK-LOG] ${CALLBACK_LOG_TABLE} missing (apply migration 0109); logging is off until then`)
    }
    return
  }
  console.error(`[HUBTEL-CALLBACK-LOG] ${what} failed:`, safeDbError(err))
}

/** Inserts one log row. Best-effort: never throws, never rejects. */
export async function logHubtelCallback(supabase: SupabaseClient, entry: CallbackLogEntry): Promise<void> {
  try {
    if (!supabase) return
    const { error } = await supabase.from(CALLBACK_LOG_TABLE).insert(shapeCallbackLogRow(entry))
    if (error) reportFailure("insert", error)
  } catch (e) {
    reportFailure("insert", e)
  }
}

type SendResult = { ok: boolean; error?: string; upstreamStatus?: number; upstreamBody?: unknown }

/**
 * Wraps a callback sender so every attempt is logged. Returns the sender's result (same object)
 * unchanged; a throwing sender is logged as failed and the error is rethrown as before.
 */
export function withOutboundLogging<R extends SendResult>(
  send: (p: { sessionId: string; orderId: string }) => Promise<R>,
  supabase: SupabaseClient
): (p: { sessionId: string; orderId: string }) => Promise<R> {
  return async p => {
    const base = { direction: "outbound_callback" as const, sessionId: p.sessionId, hubtelOrderId: p.orderId, payload: buildCallbackPayload(p) }
    let result: R
    try {
      result = await send(p)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await logHubtelCallback(supabase, { ...base, outcome: "failed", ok: false, error: message })
      throw e
    }
    await logHubtelCallback(supabase, {
      ...base,
      outcome: result.ok ? "sent" : "failed",
      ok: result.ok === true,
      httpStatus: result.upstreamStatus ?? null,
      response: result.upstreamBody ?? null,
      error: result.error ?? null,
    })
    return result
  }
}

export const CALLBACK_LOG_RETENTION_DAYS = 30

/** Deletes rows older than `days`. Best-effort: never throws. */
export async function purgeOldCallbackLogs(
  supabase: SupabaseClient,
  days: number = CALLBACK_LOG_RETENTION_DAYS,
  now: number = Date.now()
): Promise<void> {
  try {
    const cutoff = new Date(now - days * 86_400_000).toISOString()
    const { error } = await supabase.from(CALLBACK_LOG_TABLE).delete().lt("created_at", cutoff)
    if (error) reportFailure("purge", error)
  } catch (e) {
    reportFailure("purge", e)
  }
}
