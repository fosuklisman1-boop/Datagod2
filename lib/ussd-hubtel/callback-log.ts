// lib/ussd-hubtel/callback-log.ts
// Best-effort audit log of Hubtel payment traffic in BOTH directions (table hubtel_callback_logs,
// migration 0109): inbound fulfilment webhooks (Hubtel -> us) and outbound success callbacks
// (us -> relay -> Hubtel). Everything here is fire-and-forget safe: it never throws, never changes
// a caller's result, and is silent (one warning per process) until the migration is applied.
// Never stores URLs, query strings, headers, or secret values.
import type { SupabaseClient } from "@supabase/supabase-js"
import { buildCallbackPayload, type CallbackParams } from "./relay"
import { safeDbError } from "./log-safe"

export const CALLBACK_LOG_TABLE = "hubtel_callback_logs"

/** status_check: our transaction-status lookups (us -> relay -> Hubtel), migration 0110. */
export type CallbackLogDirection = "inbound_fulfillment" | "outbound_callback" | "status_check"

/** Inbound outcomes: the fulfilment route's own failures plus processFulfillment's results. */
export type InboundLogOutcome =
  | "parse_error" | "invalid_payload" | "fulfilled" | "needs_review" | "duplicate" | "unsuccessful" | "unknown_session" | "error"

/** Inbound outcomes that need a human look; logged with ok=false so "Problems only" finds them. */
const INBOUND_PROBLEMS: ReadonlySet<string> = new Set(["parse_error", "invalid_payload", "needs_review", "unknown_session", "error"])
/**
 * `isSuccessful` is the payload's IsSuccessful flag: an unknown session is only a problem when
 * money was actually taken (or we cannot tell); an unpaid one is not.
 */
export function inboundOk(outcome: InboundLogOutcome, isSuccessful?: boolean): boolean {
  if (outcome === "unknown_session") return isSuccessful === false
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

/** No log write may take longer than this (a stalled DB must never hold up a caller). */
export const LOG_WRITE_TIMEOUT_MS = 3_000
const TIMED_OUT = Symbol("callback-log-timeout")

/**
 * Runs a PostgREST write with BOTH an abort signal (cancels the HTTP request when the builder
 * supports it) and a timer race (so even a builder that ignores the signal cannot hang us).
 */
async function bounded(builder: unknown): Promise<{ error?: unknown } | typeof TIMED_OUT> {
  const b = builder as { abortSignal?: (s: AbortSignal) => unknown }
  const q = typeof b?.abortSignal === "function" ? b.abortSignal(AbortSignal.timeout(LOG_WRITE_TIMEOUT_MS)) : builder
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), LOG_WRITE_TIMEOUT_MS) })
  try {
    return await Promise.race([Promise.resolve(q as PromiseLike<{ error?: unknown }>), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function reportTimeout(what: string): void {
  // PII-free on purpose: no row content, ids or payload.
  console.warn(`[HUBTEL-CALLBACK-LOG] ${what} timed out after ${LOG_WRITE_TIMEOUT_MS}ms; entry dropped`)
}

/** Inserts one log row. Best-effort: never throws, never rejects, never takes longer than ~3s. */
export async function logHubtelCallback(supabase: SupabaseClient, entry: CallbackLogEntry): Promise<void> {
  try {
    if (!supabase) return
    const r = await bounded(supabase.from(CALLBACK_LOG_TABLE).insert(shapeCallbackLogRow(entry)))
    if (r === TIMED_OUT) return reportTimeout("insert")
    if (r?.error) reportFailure("insert", r.error)
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return reportTimeout("insert")
    reportFailure("insert", e)
  }
}

type SendResult = { ok: boolean; error?: string; upstreamStatus?: number; upstreamBody?: unknown }

/** A callback sender whose log writes are deferred until `flush()`. */
export type LoggedCallbackSender<R> = ((p: CallbackParams) => Promise<R>) & {
  /** Waits (bounded, ~3s per write) for this sender's pending log writes. Never throws. */
  flush(): Promise<void>
}

/**
 * Wraps a callback sender so every attempt is logged WITHOUT sitting between "Hubtel got the
 * callback" and dispatchCallback marking the row 'sent': the insert is only started here (it never
 * rejects) and the original result object is returned immediately; a throwing sender schedules a
 * failed entry and the same error object is rethrown. Callers `await sender.flush()` AFTER
 * dispatchCallback returns.
 */
export function withOutboundLogging<R extends SendResult>(
  send: (p: CallbackParams) => Promise<R>,
  supabase: SupabaseClient
): LoggedCallbackSender<R> {
  let pending: Promise<void>[] = []
  const schedule = (entry: CallbackLogEntry) => { pending.push(logHubtelCallback(supabase, entry)) }
  const sender = async (p: CallbackParams): Promise<R> => {
    const base = { direction: "outbound_callback" as const, sessionId: p.sessionId, hubtelOrderId: p.orderId, payload: buildCallbackPayload(p) }
    // NB: p carries serviceStatus through, so the logged payload is exactly what is sent.
    let result: R
    try {
      result = await send(p)
    } catch (e) {
      schedule({ ...base, outcome: "failed", ok: false, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
    schedule({
      ...base,
      outcome: result.ok ? "sent" : "failed",
      ok: result.ok === true,
      httpStatus: result.upstreamStatus ?? null,
      response: result.upstreamBody ?? null,
      error: result.error ?? null,
    })
    return result
  }
  const flush = async (): Promise<void> => {
    const batch = pending
    pending = []
    try { await Promise.allSettled(batch) } catch { /* allSettled never rejects; belt and braces */ }
  }
  return Object.assign(sender, { flush })
}

type StatusCheckLogResult = {
  ok: boolean; status?: string; data?: any; error?: string; upstreamStatus?: number; body?: unknown
}

/** A status checker whose log writes are deferred until `flush()` (same contract as the callback sender). */
export type LoggedStatusChecker<R> = ((sessionId: string) => Promise<R>) & { flush(): Promise<void> }

/**
 * Wraps the Hubtel transaction-status lookup so every check is logged with Hubtel's full response
 * (viewable and copyable on the admin page). Like withOutboundLogging: the insert is only started
 * here, the original result is returned untouched, a throwing checker is logged then rethrown, and
 * callers `await checker.flush()` once their work is done. Never changes the caller's behaviour.
 */
export function withStatusCheckLogging<R extends StatusCheckLogResult>(
  check: (sessionId: string) => Promise<R>,
  supabase: SupabaseClient
): LoggedStatusChecker<R> {
  let pending: Promise<void>[] = []
  const schedule = (entry: CallbackLogEntry) => { pending.push(logHubtelCallback(supabase, entry)) }
  const checker = async (sessionId: string): Promise<R> => {
    const base = { direction: "status_check" as const, sessionId, payload: { clientReference: sessionId } }
    let result: R
    try {
      result = await check(sessionId)
    } catch (e) {
      schedule({ ...base, outcome: "error", ok: false, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
    const txnId = result.data && typeof result.data === "object" ? (result.data as { transactionId?: unknown }).transactionId : undefined
    schedule({
      ...base,
      hubtelOrderId: typeof txnId === "string" ? txnId : null,
      // The Hubtel status (Paid / Unpaid / ...) when we got one; "error" when the lookup itself failed.
      outcome: result.ok ? (result.status ?? "no_status") : "error",
      ok: result.ok === true,
      httpStatus: result.upstreamStatus ?? null,
      response: result.body ?? result.data ?? null,
      error: result.error ?? null,
    })
    return result
  }
  const flush = async (): Promise<void> => {
    const batch = pending
    pending = []
    try { await Promise.allSettled(batch) } catch { /* allSettled never rejects; belt and braces */ }
  }
  return Object.assign(checker, { flush })
}

export const CALLBACK_LOG_RETENTION_DAYS = 30

/** Deletes rows older than `days` (whole days >= 1 only: never "everything"). Best-effort, bounded. */
export async function purgeOldCallbackLogs(
  supabase: SupabaseClient,
  days: number = CALLBACK_LOG_RETENTION_DAYS,
  now: number = Date.now()
): Promise<void> {
  if (!Number.isFinite(days) || days < 1) return
  try {
    const cutoff = new Date(now - days * 86_400_000).toISOString()
    const r = await bounded(supabase.from(CALLBACK_LOG_TABLE).delete().lt("created_at", cutoff))
    if (r === TIMED_OUT) return reportTimeout("purge")
    if (r?.error) reportFailure("purge", r.error)
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return reportTimeout("purge")
    reportFailure("purge", e)
  }
}
