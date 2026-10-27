/**
 * Developer API v2 bulk-SMS endpoints (SMS key): send, balance, senders, campaign list,
 * campaign detail. CREDITS PATH (tier 1): sends spend SMS credits (sms_accounts.unit_balance,
 * NOT the wallet) through the shared engine enqueueSendBatched (lib/sms/send-service.ts, unchanged).
 *
 * Every decision lives here, over injected SmsDeps, so tests need no network.
 *
 * The engine takes no client reference, so v2 claims the client reference in api_v2_idempotency
 * BEFORE the engine is called. Live send order (each step short-circuits):
 *   parse body (no I/O) -> claim
 *     replay => 200 { send, replayed: true } | conflict 409 | in_progress 409 | unknown 409 | error 503
 *   -> schedule lead (< 2 min => release, 400; deferred from parsing so replays never see it)
 *   -> account (none => release, 403) -> sender (none => undefined, the engine decides) -> template tokens
 *   -> engine: ok:true => complete the claim, 201 { send }
 *              returned no-charge error => release, mapped 400/402/403/429/503
 *              a throw / unrecognised shape => mark unknown + urgent alert, 500 OUTCOME_UNKNOWN
 *
 * MULTI-BATCH SENDS: the engine splits a send of more than 500 recipients into batches and writes
 * ONE sms_send_logs row per batch, but returns only the FIRST batch's id. `campaign_id` is therefore
 * the first batch's id, `batches` reports how many were queued, and GET /sms/campaigns/{id} describes
 * the FIRST batch only (up to 500 recipients). The docs must say so.
 *
 * SANDBOX (test keys): lib/sandbox.ts has no "sms" action (SandboxAction is a closed union backed by
 * a DB check), so the sandbox is STATELESS: same parsing, no account/credits/engine/claims, the v1
 * sandbox response shape plus `campaign_id: null`. There is no replay by reference in the sandbox.
 *
 * PRIVACY: message bodies, phone numbers and sender IDs appear in no log, alert, error message or claim.
 * Campaign detail returns recipient numbers only to the account that owns the campaign.
 */
import type { V2Context, V2HandlerResult } from "../handler"
import type { V2ErrorStatus } from "../envelope"
import type { ClaimOutcome } from "../idempotency"
import type { SmsAccount } from "@/lib/sms/account-service"
import type { ShopTokens } from "@/lib/sms/prepare"
import {
  classifySmsError,
  mapBalance,
  mapCampaign,
  mapCampaignDetail,
  mapSendSummary,
  mapSenders,
  parseSmsSendBody,
  smsErrorResponse,
  smsHash,
  SMS_PENDING_TAIL,
  type PublicSmsSendSummary,
  type SmsSendInput,
} from "../sms-rules"
import { MSG_REFERENCE_REUSED, MSG_UNAVAILABLE } from "./data"

// ---------------------------------------------------------------- deps

/** Exactly what v2 passes to enqueueSendBatched (positional there). `recipients` are the ORIGINAL unique strings. */
export interface SmsEngineParams {
  userId: string
  accountId: string
  message: string
  recipients: string[]
  tokens: ShopTokens
  /** undefined when nothing resolved: the engine then uses the platform sender or answers INVALID_SENDER_ID (v1 parity). */
  senderId: string | undefined
  scheduledFor?: Date
}

export interface SmsCampaignPage {
  rows: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}

export interface SmsCampaignRecord {
  log: Record<string, unknown>
  messages: Record<string, unknown>[]
  counts: { delivered: number; failed: number; pending: number; refunded: number }
}

export interface SmsDeps {
  claim(p: { userId: string; apiV2KeyId: string; kind: "sms"; reference: string; requestHash: string }): Promise<ClaimOutcome>
  complete(claimId: string, orderRef: string, response: unknown, userId: string): Promise<boolean>
  release(claimId: string, userId: string): Promise<boolean>
  markUnknown(claimId: string, userId: string, orderRef?: string): Promise<boolean>
  /** URGENT admin alert. PII-free: user id and client reference only. */
  alert(message: string): Promise<void>
  /** SEND path only: get or create the caller's SMS account; null when the account type has no SMS. */
  getOrCreateAccount(userId: string): Promise<SmsAccount | null>
  /** READ paths: read-only lookup of the caller's account (never creates one); null when none. Throws on a read error. */
  lookupAccount(userId: string): Promise<SmsAccount | null>
  /** The sender a send uses: the requested one, else the account default (active only), else its first active one; null when none. */
  resolveSender(account: SmsAccount, requested: string | null): Promise<string | null>
  shopTokens(account: SmsAccount): Promise<ShopTokens>
  /** enqueueSendBatched's raw result (BatchedSendResult | EnqueueSendError). Throws propagate. */
  engine(p: SmsEngineParams): Promise<unknown>
  listCampaigns(accountId: string, i: { status: string; page: number }): Promise<SmsCampaignPage>
  /** null when the batch is not this account's (or missing). */
  getCampaign(accountId: string, campaignId: number): Promise<SmsCampaignRecord | null>
  listSenders(accountId: string): Promise<Record<string, unknown>[]>
  pendingUnits(accountId: string): Promise<number>
  now(): number
}

// ---------------------------------------------------------------- messages

export const SMS_BATCH_SIZE = 500
export const SMS_PAGE_SIZE = 25

export const MSG_SMS_NOT_FOUND = "Campaign not found"
export const MSG_SMS_NOT_ENABLED = "SMS_NOT_ENABLED: SMS isn't enabled for this account"
export const MSG_SMS_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${SMS_PENDING_TAIL}`
export const MSG_SMS_PRIOR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${SMS_PENDING_TAIL}`
export const MSG_SMS_OUTCOME_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this send is not confirmed yet, so credits may have been reserved. ${SMS_PENDING_TAIL}`
export const MSG_SMS_CLAIM_UNAVAILABLE =
  "UNAVAILABLE: could not reserve this reference; nothing was sent or charged. Retry with the same reference"

const LOG_COMPLETE_FAILED = "[API v2] sms: claim not finalised after a successful send (reads as unknown later)"
const LOG_RELEASE_FAILED = "[API v2] sms: claim release failed (reference stays blocked)"
const LOG_UNKNOWN_FAILED = "[API v2] sms: could not mark claim unknown (reads as unknown once stale)"
const LOG_AMBIGUOUS = "[API v2] sms: ambiguous engine outcome; claim marked unknown"

const ERROR_STATUSES = new Set<number>([400, 401, 402, 403, 404, 409, 429, 500, 502, 503])

/** sms_send_logs.status values a caller may filter on (derived "cancelled" cannot be filtered). */
const FILTER_STATUSES: ReadonlySet<string> = new Set(["queued", "sending", "sent", "partial", "failed", "blocked", "held", "scheduled"])

function fail(status: V2ErrorStatus, message: string): V2HandlerResult {
  return { status, error: { status, message } }
}
const ok = (status: number, data: unknown): V2HandlerResult => ({ status, data })
const notFound = () => fail(404, MSG_SMS_NOT_FOUND)

// ---------------------------------------------------------------- helpers

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

async function safeRelease(deps: SmsDeps, claimId: string, userId: string): Promise<void> {
  let released = false
  try {
    released = await deps.release(claimId, userId)
  } catch {
    released = false
  }
  if (!released) console.error(LOG_RELEASE_FAILED)
}

async function safeMarkUnknown(deps: SmsDeps, claimId: string, userId: string, orderRef?: string): Promise<void> {
  let marked = false
  try {
    marked = orderRef ? await deps.markUnknown(claimId, userId, orderRef) : await deps.markUnknown(claimId, userId)
  } catch {
    marked = false
  }
  if (!marked) console.error(LOG_UNKNOWN_FAILED)
}

async function safeAlert(deps: SmsDeps, message: string): Promise<void> {
  try {
    await deps.alert(message)
  } catch {
    // alerting must never break the flow
  }
}

async function markAmbiguous(deps: SmsDeps, claimId: string, ctx: V2Context, reference: string, orderRef?: string): Promise<void> {
  await safeMarkUnknown(deps, claimId, ctx.userId, orderRef)
  await safeAlert(
    deps,
    `SMS API outcome uncertain: claim ${reference}, user ${ctx.userId} (sms)${orderRef ? `, campaign ${orderRef}` : ""}. Check the SMS credits ledger and the campaign before anything is resent.`
  )
}

function errorResult(e: unknown): V2HandlerResult {
  const r = smsErrorResponse(e)
  const status = (ERROR_STATUSES.has(r.status) ? r.status : 500) as V2ErrorStatus
  return fail(status, `${r.code}: ${r.message}`)
}

/** A stored claim response re-read through the allow-list (mapSendSummary). */
function summaryFromStored(stored: unknown): PublicSmsSendSummary {
  const s = isObject(stored) ? stored : {}
  return mapSendSummary({
    ok: true,
    batches: s.batches,
    totalQueued: s.total,
    segments: s.segments,
    creditsReserved: s.credits_reserved,
    invalidSkipped: s.invalid_skipped,
    partial: s.partial === true,
    stoppedReason: typeof s.stopped_reason === "string" ? s.stopped_reason : undefined,
    held: s.held === true,
    scheduled: s.scheduled === true,
    scheduledFor: typeof s.scheduled_for === "string" ? s.scheduled_for : null,
    sendLogId: typeof s.campaign_id === "string" ? s.campaign_id : null,
  } as any)
}

// ---------------------------------------------------------------- send

export function handleSmsSend(deps: SmsDeps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const parsed = parseSmsSendBody(body, new Date(deps.now()))
    if (!parsed.ok) return fail(400, parsed.error)
    const input = parsed.value
    if (ctx.environment === "test") return input.scheduleLeadError ? fail(400, input.scheduleLeadError) : sandboxSend(input)
    return liveSend(deps, input, ctx)
  }
}

function sandboxSend(input: SmsSendInput): V2HandlerResult {
  const scheduled = input.scheduledFor !== null
  const send = mapSendSummary({
    ok: true,
    batches: Math.max(1, Math.ceil(input.recipientCount / SMS_BATCH_SIZE)),
    totalQueued: input.recipientCount,
    segments: 1,
    creditsReserved: input.recipientCount,
    invalidSkipped: 0,
    partial: false,
    held: false,
    scheduled,
    scheduledFor: scheduled ? input.scheduledFor!.toISOString() : null,
    sendLogId: null,
  })
  return ok(201, { send, sandbox: true })
}

async function liveSend(deps: SmsDeps, input: SmsSendInput, ctx: V2Context): Promise<V2HandlerResult> {
  let outcome: ClaimOutcome
  try {
    outcome = await deps.claim({
      userId: ctx.userId,
      apiV2KeyId: ctx.keyId,
      kind: "sms",
      reference: input.reference,
      requestHash: smsHash(input),
    })
  } catch {
    outcome = { kind: "error" }
  }
  switch (outcome.kind) {
    case "replay":
      return ok(200, { send: summaryFromStored(outcome.response), replayed: true })
    case "conflict":
      return fail(409, MSG_REFERENCE_REUSED)
    case "in_progress":
      return fail(409, MSG_SMS_IN_PROGRESS)
    case "unknown":
      return fail(409, MSG_SMS_PRIOR_UNKNOWN)
    case "claimed":
      break
    default:
      return fail(503, MSG_SMS_CLAIM_UNAVAILABLE)
  }
  const claimId = outcome.claimId

  // The minimum schedule lead is checked only for a FRESH send: a retry of an already-claimed scheduled
  // send must be answered (replay / 409) even when its time has since come close or passed. Nothing has
  // been reserved yet, so the claim is released.
  if (input.scheduleLeadError) {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(400, input.scheduleLeadError)
  }

  // Everything until the engine call is read-only: any failure frees the reference (nothing reserved).
  let account: SmsAccount | null
  try {
    account = await deps.getOrCreateAccount(ctx.userId)
  } catch {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(503, MSG_UNAVAILABLE)
  }
  if (!account) {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(403, MSG_SMS_NOT_ENABLED)
  }

  let senderId: string | null
  try {
    senderId = await deps.resolveSender(account, input.senderId)
  } catch {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(503, MSG_UNAVAILABLE)
  }
  // No resolvable sender is NOT refused here: like v1, pass undefined and let the engine fall back to
  // the platform sender or answer INVALID_SENDER_ID itself (mapped, no-charge, frees the reference).

  let tokens: ShopTokens
  try {
    tokens = await deps.shopTokens(account)
  } catch {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(503, MSG_UNAVAILABLE)
  }

  // Engine. Only classified no-charge results free the reference.
  let result: unknown
  try {
    result = await deps.engine({
      userId: ctx.userId,
      accountId: account.id,
      message: input.message,
      recipients: input.recipients,
      tokens,
      senderId: senderId ?? undefined,
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    })
  } catch {
    await markAmbiguous(deps, claimId, ctx, input.reference)
    console.error(LOG_AMBIGUOUS)
    return fail(500, MSG_SMS_OUTCOME_UNKNOWN)
  }

  if (!isObject(result) || result.ok !== true) {
    if (classifySmsError(result) === "no_charge") {
      await safeRelease(deps, claimId, ctx.userId)
      return errorResult(result)
    }
    await markAmbiguous(deps, claimId, ctx, input.reference)
    console.error(LOG_AMBIGUOUS)
    return fail(500, MSG_SMS_OUTCOME_UNKNOWN)
  }

  const send = mapSendSummary(result as any)
  const orderRef = send.campaign_id ?? input.reference
  let completed = false
  try {
    completed = await deps.complete(claimId, orderRef, send, ctx.userId)
  } catch {
    completed = false
  }
  if (!completed) {
    console.error(LOG_COMPLETE_FAILED)
    await markAmbiguous(deps, claimId, ctx, input.reference, orderRef)
  }
  return ok(201, { send })
}

// ---------------------------------------------------------------- balance / senders

const SANDBOX_CREDITS = 1000

export function handleSmsBalance(deps: SmsDeps) {
  return async (ctx: V2Context): Promise<V2HandlerResult> => {
    if (ctx.environment === "test") {
      return ok(200, { balance: { credits: SANDBOX_CREDITS, pending_credits: 0, status: "active" }, sandbox: true })
    }
    try {
      const account = await deps.lookupAccount(ctx.userId)
      if (!account) return fail(403, MSG_SMS_NOT_ENABLED)
      const pending = await deps.pendingUnits(account.id)
      return ok(200, { balance: mapBalance(account, pending) })
    } catch {
      return fail(503, MSG_UNAVAILABLE)
    }
  }
}

export function handleSmsSenders(deps: SmsDeps) {
  return async (ctx: V2Context): Promise<V2HandlerResult> => {
    if (ctx.environment === "test") {
      return ok(200, {
        senders: [{ sender_id: "SANDBOX", status: "active", is_default: true, created_at: null }],
        sandbox: true,
      })
    }
    try {
      const account = await deps.lookupAccount(ctx.userId)
      if (!account) return fail(403, MSG_SMS_NOT_ENABLED)
      const rows = await deps.listSenders(account.id)
      return ok(200, { senders: mapSenders(rows, account.default_sender_id ?? null) })
    } catch {
      return fail(503, MSG_UNAVAILABLE)
    }
  }
}

// ---------------------------------------------------------------- campaigns

export interface SmsCampaignQuery {
  page?: string | null
  status?: string | null
}

export function handleSmsCampaigns(deps: SmsDeps) {
  return async (query: SmsCampaignQuery, ctx: V2Context): Promise<V2HandlerResult> => {
    let page = 1
    if (query.page !== undefined && query.page !== null && query.page !== "") {
      if (!/^[1-9][0-9]{0,5}$/.test(query.page)) return fail(400, "page must be a whole number from 1 to 999999")
      page = Number(query.page)
    }
    let status = ""
    if (query.status !== undefined && query.status !== null && query.status !== "") {
      if (!FILTER_STATUSES.has(query.status)) {
        return fail(400, `status must be one of: ${[...FILTER_STATUSES].join(", ")}`)
      }
      status = query.status
    }

    const empty = { campaigns: [], page, page_size: SMS_PAGE_SIZE, total: 0, has_more: false }
    if (ctx.environment === "test") return ok(200, { ...empty, sandbox: true })

    try {
      const account = await deps.lookupAccount(ctx.userId)
      if (!account) return ok(200, empty)
      const res = await deps.listCampaigns(account.id, { status, page })
      const rows = Array.isArray(res?.rows) ? res.rows : []
      const total = Number.isFinite(Number(res?.total)) ? Math.max(0, Math.floor(Number(res.total))) : 0
      return ok(200, {
        campaigns: rows.map(mapCampaign),
        page,
        page_size: SMS_PAGE_SIZE,
        total,
        has_more: page * SMS_PAGE_SIZE < total,
      })
    } catch {
      return fail(503, MSG_UNAVAILABLE)
    }
  }
}

export function handleSmsCampaign(deps: SmsDeps) {
  return async (campaignId: string, ctx: V2Context): Promise<V2HandlerResult> => {
    // sms_send_logs.id is a bigserial: anything else cannot be ours, and gets the same 404 as a miss.
    if (typeof campaignId !== "string" || !/^[1-9][0-9]{0,14}$/.test(campaignId)) return notFound()
    if (ctx.environment === "test") return notFound()
    try {
      const account = await deps.lookupAccount(ctx.userId)
      if (!account) return notFound()
      const record = await deps.getCampaign(account.id, Number(campaignId))
      if (!record) return notFound()
      return ok(200, { campaign: mapCampaignDetail(record) })
    } catch {
      return fail(503, MSG_UNAVAILABLE)
    }
  }
}
