/**
 * Pure request rules for the Developer API v2 bulk-SMS endpoints (plan 6). No I/O.
 * Money-adjacent (credits) and abuse-adjacent (messaging): every parser is strict and
 * fails closed, and every mapper returns an exact allow-list. The SMS engine
 * (lib/sms/send-service.ts enqueueSendBatched) is not touched; price (credits) is always
 * decided server-side by the engine.
 *
 * Privacy: message bodies and phone numbers never appear in an error message. The request
 * hash is a sha256 digest only. Campaign detail returns recipient numbers only to the
 * account that owns the campaign (the callers scope by account id).
 *
 * Imports are type-only from lib/sms/*: those modules create a Supabase client at load.
 */

import { parseReference } from "./data-orders"
import { requestHash, type EngineErrorClass, type ErrorResponse } from "./commission"
import { checkSchedule, MIN_SCHEDULE_MS } from "@/lib/sms/schedule"
import type { BatchedSendResult } from "@/lib/sms/send-service"
import type { SmsAccount } from "@/lib/sms/account-service"

type Fail = { ok: false; error: string }

/** Same ceiling as SMS_MAX_TOTAL in lib/sms/send-service.ts:25 (imported value would pull the DB client). */
export const SMS_MAX_RECIPIENTS = 5000
/** Bound on the RAW array before dedupe, so a hostile body cannot make us scan millions of entries. */
const RAW_RECIPIENTS_CEILING = 50_000

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const count = (v: unknown): number => Math.max(0, Math.floor(num(v)))
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null)

// ---- forbidden request fields ----

const FORBIDDEN_FIELDS = new Set([
  "provider",
  "price",
  "cost",
  "credits",
  "status",
  "user_id",
  "account_id",
  "fee",
  "amount",
])

function hasForbiddenField(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((k) => FORBIDDEN_FIELDS.has(k.toLowerCase()))
}

// ---- recipients ----

/**
 * Mirrors normalizePhoneNumber in lib/sms/send-service.ts:28-36 EXACTLY (separators " -()" stripped;
 * 0XXXXXXXXX, +233XXXXXXXXX, 233XXXXXXXXX, 9 digits) so that the numbers we dedupe and hash are the
 * numbers the engine bills. Returns +233XXXXXXXXX or null when the engine would skip the entry.
 */
export function normalizeSmsRecipient(phone: string): string | null {
  const cleaned = String(phone ?? "").replace(/[\s\-()]/g, "")
  if (!cleaned) return null
  if (cleaned.startsWith("0") && cleaned.length === 10) return `+233${cleaned.slice(1)}`
  if (cleaned.startsWith("+233") && cleaned.length === 13) return cleaned
  if (cleaned.startsWith("233") && cleaned.length === 12) return `+${cleaned}`
  if (/^\d{9}$/.test(cleaned)) return `+233${cleaned}`
  return null
}

// ---- request body ----

export interface SmsSendInput {
  reference: string
  /** Exactly as sent. */
  message: string
  /** The ORIGINAL strings (first spelling of each distinct number), passed to the engine as v1 does. */
  recipients: string[]
  recipientCount: number
  /** Sorted unique normalised E.164 (invalid entries keep a raw: marker). Used for the hash only. */
  normalizedRecipients: string[]
  senderId: string | null
  scheduledFor: Date | null
  /**
   * The 2-minute minimum-lead failure message, or null. Deferred on purpose: the lead depends on the
   * clock, so a retry of an already-claimed scheduled send must reach the claim (replay / 409) before
   * this is looked at. The caller enforces it only after a FRESH claim (and releases the claim then).
   * Format and the 30-day upper bound are still rejected at parse time.
   */
  scheduleLeadError: string | null
}

export function parseSmsSendBody(body: unknown, now: Date = new Date()): { ok: true; value: SmsSendInput } | Fail {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }
  if (hasForbiddenField(body)) return { ok: false, error: "Unexpected field" }

  const ref = parseReference(body.reference)
  if (!ref.ok) return ref

  const message = body.message
  if (typeof message !== "string" || message.length < 3 || message.length > 1000) {
    return { ok: false, error: "message must be a string between 3 and 1000 characters" }
  }

  const rawList = body.recipients
  const badRecipients: Fail = {
    ok: false,
    error: `recipients must be a non-empty array of strings, at most ${SMS_MAX_RECIPIENTS} unique numbers`,
  }
  if (!Array.isArray(rawList) || rawList.length === 0 || rawList.length > RAW_RECIPIENTS_CEILING) return badRecipients
  const seen = new Set<string>()
  const recipients: string[] = []
  const keys: string[] = []
  for (const item of rawList) {
    if (typeof item !== "string") return badRecipients
    const norm = normalizeSmsRecipient(item)
    const key = norm ?? `raw:${item.trim()}`
    if (seen.has(key)) continue
    seen.add(key)
    recipients.push(item)
    keys.push(key)
    if (recipients.length > SMS_MAX_RECIPIENTS) return badRecipients
  }

  let senderId: string | null = null
  if (body.sender_id !== undefined && body.sender_id !== null) {
    if (typeof body.sender_id !== "string" || body.sender_id.trim().length === 0) {
      return { ok: false, error: "sender_id must be a non-empty string" }
    }
    senderId = body.sender_id.trim()
  }

  let scheduledFor: Date | null = null
  let scheduleLeadError: string | null = null
  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    const sched = checkSchedule(body.scheduled_at, now)
    if (sched.ok) {
      scheduledFor = sched.at
    } else {
      // Re-check as if the instant were exactly the minimum lead away: that validates the format and
      // yields the instant. Then decide whether the strict failure was the lead (deferred) or not.
      const raw = typeof body.scheduled_at === "string" ? Date.parse(body.scheduled_at.trim()) : NaN
      const lenient = Number.isFinite(raw) ? checkSchedule(body.scheduled_at, new Date(raw - MIN_SCHEDULE_MS)) : sched
      if (!lenient.ok || lenient.at.getTime() - now.getTime() >= MIN_SCHEDULE_MS) return { ok: false, error: sched.message }
      scheduledFor = lenient.at
      scheduleLeadError = sched.message
    }
  }

  return {
    ok: true,
    value: {
      reference: ref.reference,
      message,
      recipients,
      recipientCount: recipients.length,
      normalizedRecipients: [...keys].sort(),
      senderId,
      scheduledFor,
      scheduleLeadError,
    },
  }
}

/** Message, sorted unique normalised recipients, sender and schedule instant. The reference is excluded. */
export function smsHash(i: SmsSendInput): string {
  return requestHash("sms", {
    message: i.message,
    recipients: i.normalizedRecipients,
    sender_id: i.senderId,
    scheduled_at: i.scheduledFor ? i.scheduledFor.toISOString() : null,
  })
}

// ---- engine errors ----

/**
 * enqueueSendBatched (lib/sms/send-service.ts:575) returns { ok:false, error } for every failure it
 * handles. The classifier is derived from these places:
 *  - send-service.ts:65-82 EnqueueSendError.error union (the 12 names below);
 *  - :519-572 runSequentialBatches: an error on the FIRST batch is returned with nothing sent or
 *    charged (a later-batch error becomes partial:true, which is a success and never reaches here);
 *  - :137-158, :190, :202 pre-debit returns (SMS_DISABLED, TOO_MANY_RECIPIENTS, INVALID_SENDER_ID,
 *    EMPTY_MESSAGE, BLOCKED, NO_VALID_RECIPIENTS) happen before debit_sms_for_send (:208);
 *  - :214-216 NOT_ACTIVATED / SUSPENDED / INSUFFICIENT_CREDITS come back from the debit RPC itself,
 *    i.e. nothing was debited;
 *  - :303-349 ENQUEUE_FAILED is deliberately NOT here: the debit happened and the compensating
 *    adjust_sms_units refund is best-effort (its own failure is only logged), so a retry could
 *    double-charge or double-send. It is AMBIGUOUS: claim marked unknown, urgent alert;
 *  - :618-701 enforced path: SMS_DISABLED, INVALID_SENDER_ID, EMPTY_MESSAGE, POLICY_REJECTED,
 *    SEND_IN_PROGRESS and the policy BLOCKED are all returned before any debit.
 * A THROW (runSequentialBatches rethrows a first-batch throw, :541) or any shape we do not
 * recognise is ambiguous: never re-run, never release the claim.
 */
const NO_CHARGE_ERRORS: ReadonlySet<string> = new Set([
  "EMPTY_MESSAGE",
  "BLOCKED",
  "TOO_MANY_RECIPIENTS",
  "NO_VALID_RECIPIENTS",
  "NOT_ACTIVATED",
  "SUSPENDED",
  "INSUFFICIENT_CREDITS",
  "INVALID_SENDER_ID",
  "SMS_DISABLED",
  "POLICY_REJECTED",
  "SEND_IN_PROGRESS",
])

export function classifySmsError(e: unknown): EngineErrorClass {
  if (!isPlainObject(e) || e.ok !== false) return "ambiguous"
  return typeof e.error === "string" && NO_CHARGE_ERRORS.has(e.error) ? "no_charge" : "ambiguous"
}

/** lib/sms/enforcement.ts:33 BLOCKED_SAFE_REASON (value copied: that module needs the DB client at load). */
const BLOCKED_SAFE_REASON = "This message contains content we can't send."
const POLICY_FALLBACK = "This send was not accepted by the sending policy."
const MAX_REASON = 300

/** Same rule as customerBlockedReason (enforcement.ts:40): the engine's text is customer-safe ONLY when it carries a policy code. */
function policyReason(e: Record<string, unknown>, fallback: string): string {
  if (e.code && typeof e.reason === "string" && e.reason.trim()) return e.reason.trim().slice(0, MAX_REASON)
  return fallback
}

export const SMS_PENDING_TAIL =
  "Do not send this again under a new reference. Check GET /sms/campaigns and GET /sms/balance, or contact support quoting the reference"

/** Fixed messages; engine text is forwarded only for the policy `reason` (customer-safe by construction). */
export function smsErrorResponse(e: unknown): ErrorResponse {
  if (classifySmsError(e) === "no_charge") {
    const err = e as Record<string, unknown>
    switch (err.error) {
      case "INSUFFICIENT_CREDITS":
        return { status: 402, code: "INSUFFICIENT_CREDITS", message: "Not enough SMS credits for this send" }
      case "NOT_ACTIVATED":
        return { status: 403, code: "NOT_ACTIVATED", message: "SMS is not activated for this account" }
      case "SUSPENDED":
        return { status: 403, code: "SUSPENDED", message: "SMS is suspended for this account" }
      case "INVALID_SENDER_ID":
        return { status: 400, code: "INVALID_SENDER_ID", message: "sender_id is not available for this account" }
      case "BLOCKED":
        return { status: 400, code: "BLOCKED", message: policyReason(err, BLOCKED_SAFE_REASON) }
      case "POLICY_REJECTED": {
        const unavailable = err.code === "FEATURE_DISABLED" || err.code === "POLICY_UNAVAILABLE"
        return {
          status: unavailable ? 503 : 400,
          code: "POLICY_REJECTED",
          message: policyReason(err, POLICY_FALLBACK),
        }
      }
      case "SMS_DISABLED":
        return { status: 503, code: "SMS_DISABLED", message: "SMS is temporarily unavailable. Please try again later." }
      case "SEND_IN_PROGRESS":
        return {
          status: 429,
          code: "SEND_IN_PROGRESS",
          message: "Another send from your account is still being processed. Retry this same request with the same reference in a few seconds",
        }
      case "EMPTY_MESSAGE":
        return { status: 400, code: "EMPTY_MESSAGE", message: "message is empty after preparation" }
      case "TOO_MANY_RECIPIENTS":
        return { status: 400, code: "TOO_MANY_RECIPIENTS", message: `At most ${SMS_MAX_RECIPIENTS} recipients per send` }
      case "NO_VALID_RECIPIENTS":
        return { status: 400, code: "NO_VALID_RECIPIENTS", message: "None of the recipients is a valid phone number" }
    }
  }
  // A throw, or a shape we do not recognise: credits may or may not have been reserved.
  return {
    status: 500,
    code: "OUTCOME_UNKNOWN",
    message: `The outcome of this send is unknown, so credits may have been reserved. ${SMS_PENDING_TAIL}`,
  }
}

// ---- mappers ----

export type SmsCampaignStatus =
  | "queued"
  | "sending"
  | "sent"
  | "partial"
  | "failed"
  | "blocked"
  | "held"
  | "scheduled"
  | "cancelled"
  | "unknown"

/** sms_send_logs.status values (lib/sms/customer-reads.ts:17 RECORD_STATUSES). */
const LOG_STATUSES: ReadonlySet<string> = new Set(["queued", "sending", "sent", "partial", "failed", "blocked", "held", "scheduled"])

function mapLogStatus(status: unknown, cancelled: unknown): SmsCampaignStatus {
  const s = typeof status === "string" ? status.trim().toLowerCase() : ""
  if (s === "failed" && cancelled === true) return "cancelled"
  return LOG_STATUSES.has(s) ? (s as SmsCampaignStatus) : "unknown"
}

/** The error names a later batch can stop on, plus the generic one (send-service.ts:541 "SEND_ERROR"). */
const STOP_REASONS: ReadonlySet<string> = new Set([...NO_CHARGE_ERRORS, "ENQUEUE_FAILED", "SEND_ERROR"])

export interface PublicSmsSendSummary {
  campaign_id: string | null
  status: "held" | "scheduled" | "queued"
  total: number
  batches: number
  segments: number
  credits_reserved: number
  invalid_skipped: number
  partial: boolean
  stopped_reason: string | null
  held: boolean
  scheduled: boolean
  scheduled_for: string | null
}

/**
 * Allow-list of a successful BatchedSendResult. `campaign_id` is the FIRST batch's send log id (a send
 * of more than 500 recipients has one log per batch). Also the shape stored in the claim response, so it
 * holds no message body and no recipients.
 */
export function mapSendSummary(r: BatchedSendResult): PublicSmsSendSummary {
  const partial = r.partial === true
  const held = r.held === true
  const scheduled = r.scheduled === true
  const reason = typeof r.stoppedReason === "string" && STOP_REASONS.has(r.stoppedReason) ? r.stoppedReason : "SEND_ERROR"
  return {
    campaign_id: r.sendLogId === null || r.sendLogId === undefined ? null : String(r.sendLogId),
    status: held ? "held" : scheduled ? "scheduled" : "queued",
    total: count(r.totalQueued),
    batches: count(r.batches),
    segments: count(r.segments),
    credits_reserved: count(r.creditsReserved),
    invalid_skipped: count(r.invalidSkipped),
    partial,
    stopped_reason: partial ? reason : null,
    held,
    scheduled,
    scheduled_for: scheduled ? isoOrNull(r.scheduledFor) : null,
  }
}

export interface PublicSmsCampaign {
  campaign_id: string
  status: SmsCampaignStatus
  sender_id: string | null
  recipient_count: number
  segments: number
  credits_reserved: number
  credits_used: number
  scheduled_for: string | null
  created_at: string | null
  completed_at: string | null
}

/**
 * One sms_send_logs row as returned by listRecords/getRecord (customer-reads.ts LOG_COLUMNS + the derived
 * `cancelled`). The message body, source, policy data and account id are dropped.
 */
export function mapCampaign(row: any): PublicSmsCampaign {
  const r = row ?? {}
  return {
    campaign_id: r.id === null || r.id === undefined ? "" : String(r.id),
    status: mapLogStatus(r.status, r.cancelled),
    sender_id: typeof r.sender_id === "string" && r.sender_id ? r.sender_id : null,
    recipient_count: count(r.recipients_count),
    segments: count(r.segments),
    credits_reserved: count(r.credits_reserved),
    credits_used: count(r.credits_used),
    scheduled_for: isoOrNull(r.scheduled_for),
    created_at: isoOrNull(r.created_at),
    completed_at: isoOrNull(r.completed_at),
  }
}

export type SmsRecipientStatus = "delivered" | "failed" | "sent" | "pending"

export interface PublicSmsRecipient {
  /** E.164 (+233XXXXXXXXX). */
  phone: string
  status: SmsRecipientStatus
  /** The credit for this message was returned. */
  refunded: boolean
}

export interface PublicSmsCampaignDetail extends PublicSmsCampaign {
  delivery: { delivered: number; failed: number; pending: number; refunded: number }
  recipients: PublicSmsRecipient[]
}

function recipientPhone(stored: unknown): string {
  const s = str(stored)
  return /^\+233[0-9]{9}$/.test(s) ? s : (normalizeSmsRecipient(s) ?? s)
}

function mapRecipientStatus(m: Record<string, unknown>): SmsRecipientStatus {
  if (m.delivery_status === "delivered") return "delivered"
  if (m.status === "failed" || m.delivery_status === "failed") return "failed"
  if (m.status === "sent") return "sent"
  return "pending"
}

/**
 * getRecord's { log, messages, counts } (customer-reads.ts:160). Per-recipient provider internals
 * (attempts, last_error, processed_at, row ids, delivery_status detail) are dropped.
 */
export function mapCampaignDetail(record: any): PublicSmsCampaignDetail {
  const rec = record ?? {}
  const msgs: any[] = Array.isArray(rec.messages) ? rec.messages : []
  const c = rec.counts ?? {}
  return {
    ...mapCampaign(rec.log),
    delivery: { delivered: count(c.delivered), failed: count(c.failed), pending: count(c.pending), refunded: count(c.refunded) },
    recipients: msgs.map((m) => {
      const x = m ?? {}
      return { phone: recipientPhone(x.phone), status: mapRecipientStatus(x), refunded: x.refunded === true }
    }),
  }
}

export interface PublicSmsSender {
  sender_id: string
  status: "pending" | "active" | "paused" | "rejected" | "revoked" | "unavailable"
  is_default: boolean
  created_at: string | null
}

/** sms_sender_ids.local_status values (migration 20261010_sms_platform_foundation.sql:60). */
const SENDER_STATUSES: ReadonlySet<string> = new Set(["pending", "active", "paused", "rejected", "revoked"])

/** `defaultSenderRowId` is sms_accounts.default_sender_id (a sms_sender_ids.id); only an ACTIVE sender can be the default. */
export function mapSenders(rows: any, defaultSenderRowId: string | null): PublicSmsSender[] {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => {
    const r = row ?? {}
    const st = typeof r.local_status === "string" ? r.local_status : ""
    const status = SENDER_STATUSES.has(st) ? (st as PublicSmsSender["status"]) : "unavailable"
    return {
      sender_id: str(r.sender_id),
      status,
      is_default: status === "active" && defaultSenderRowId !== null && r.id === defaultSenderRowId,
      created_at: isoOrNull(r.created_at),
    }
  })
}

export interface PublicSmsBalance {
  credits: number
  pending_credits: number
  status: "inactive" | "active" | "suspended" | "unknown"
}

/** sms_accounts.status check: inactive | active | suspended (migration 0065:11). */
export function mapBalance(account: Pick<SmsAccount, "unit_balance" | "status">, pending: number): PublicSmsBalance {
  const st = account?.status
  return {
    credits: count(account?.unit_balance),
    pending_credits: count(pending),
    status: st === "inactive" || st === "active" || st === "suspended" ? st : "unknown",
  }
}
