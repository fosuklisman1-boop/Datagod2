/**
 * Developer API v2 airtime endpoints (commission key): purchase, order
 * lookup, order list. MONEY PATH (tier 1): this moves wallet money through
 * the shared engine purchaseAirtime (lib/airtime-service.ts).
 *
 * Every decision lives here, over injected AirtimeDeps, so tests need no
 * network. Routes only wire real deps (airtime-deps.ts) and withV2.
 *
 * The engine takes no client reference and its own duplicate check is not
 * atomic, so v2 claims the client reference in api_v2_idempotency (UNIQUE on
 * user, kind, reference) BEFORE the engine is called. Two requests with one
 * reference can therefore never both reach the engine.
 *
 * Live purchase order (each step short-circuits):
 *   parse body (price-like fields rejected, no I/O) -> claim
 *     replay      => 200 { order, replayed: true }   (no gate, no engine)
 *     conflict    => 409 REFERENCE_REUSED
 *     in_progress => 409 REQUEST_IN_PROGRESS
 *     unknown     => 409 OUTCOME_UNKNOWN
 *     error       => 503 (fail closed, retryable)
 *   -> account phone gate (block or throw: release the claim, 403)
 *   -> engine
 *     success                => complete the claim, 201 { order, new_balance }
 *     no-charge error code   => release the claim, mapped 400/402/409/503
 *     anything else / throws => mark the claim unknown, generic 500
 *
 * Messages are fixed strings with the machine code as a prefix; engine text,
 * recipient numbers and bodies are never echoed or logged.
 */
import type { V2Context, V2HandlerResult } from "../handler"
import type { V2ErrorStatus } from "../envelope"
import type { ClaimOutcome } from "../idempotency"
import {
  airtimeErrorResponse,
  airtimeHash,
  classifyEngineError,
  mapAirtimeOrder,
  mapClaimState,
  mapCommissionStatus,
  parseAirtimeBody,
  parseAirtimeNetwork,
  parseAmountPesewas,
  type AirtimeInput,
  type PublicAirtimeOrder,
} from "../commission"
import { normalizeRecipient, parseReference } from "../data-orders"
import { MSG_PHONE_GATE, MSG_REFERENCE_REUSED, MSG_UNAVAILABLE } from "./data"

// ---------------------------------------------------------------- deps

/** Exactly what v2 passes to purchaseAirtime. Never a shopId. */
export interface AirtimeEngineParams {
  userId: string
  network: "MTN" | "AT" | "Telecel"
  beneficiaryPhone: string
  airtimeAmount: number
  /** Always true for v2: the recipient gets the full amount (fee on top when cashback is not applied). */
  paySeparately: true
  channel: "api"
  expectedPay?: number
}

/** The subset of PurchaseAirtimeResult v2 reads. */
export interface AirtimeEngineResult {
  order: {
    id: string
    reference_code: string
    network: string
    beneficiary_phone: string
    airtime_amount: number
    fee_amount: number
    total_paid: number
    status: string
  }
  newBalance: number
}

/** The allow-listed airtime_orders columns v2 selects (filtered by user_id). */
export interface AirtimeOrderRow {
  reference_code: string
  network: string
  beneficiary_phone: string
  airtime_amount: number | string
  fee_amount: number | string | null
  total_paid: number | string | null
  cashback_amount: number | string | null
  status: string
  created_at: string
}

/** What lib/sandbox.ts getSandboxOrder / listSandboxOrders return. */
export interface AirtimeSandboxOrder {
  reference: string
  action: string
  response: unknown
  price: number | string
  created_at: string
  status: string
}

export interface AirtimeSandboxPlaceParams {
  userId: string
  apiV2KeyId: string
  action: "airtime"
  reference: string
  request: Record<string, unknown>
  price: number
  orderFields: Record<string, unknown>
}

export type AirtimeSandboxPlaceResult =
  | { success: true; order: Record<string, unknown>; newBalance: number }
  | { success: false; error: string; status: number }

export interface AirtimeDeps {
  claim(p: { userId: string; apiV2KeyId: string; kind: "airtime"; reference: string; requestHash: string }): Promise<ClaimOutcome>
  /** Each finalisation is owner-guarded: callers always pass ctx.userId. */
  complete(claimId: string, orderRef: string, response: unknown, userId: string): Promise<boolean>
  release(claimId: string, userId: string): Promise<boolean>
  /** `orderRef`: the engine's order when it supplied one (complete failed after success), kept on the unknown claim. */
  markUnknown(claimId: string, userId: string, orderRef?: string): Promise<boolean>
  /**
   * URGENT admin alert for an ambiguous outcome (same notifier as the bills
   * "debit uncertain" alert). Message is PII-free: user id and client reference only.
   */
  alert(message: string): Promise<void>
  getClaim(
    userId: string,
    reference: string
  ): Promise<{ orderRef: string | null; status: string; response: unknown; createdAt?: string | null } | null>
  /** null on a read error (the list answers 503, never an empty 200). */
  listClaims(userId: string, limit: number): Promise<{ reference: string; orderRef: string | null; status: string }[] | null>
  engine(p: AirtimeEngineParams): Promise<AirtimeEngineResult>
  /** Owner-scoped; null when missing or unreadable. */
  getOrderByCode(userId: string, code: string): Promise<AirtimeOrderRow | null>
  /** Owner-scoped, one query; null on a read error. */
  getOrdersByCodes(userId: string, codes: string[]): Promise<AirtimeOrderRow[] | null>
  /** Account phone gate; only `true` passes, a throw is a block. */
  phoneGate(userId: string): Promise<boolean>
  sandbox: {
    getOrder(userId: string, reference: string): Promise<AirtimeSandboxOrder | null>
    /** null on a read error. */
    listOrders(userId: string, action: "airtime", limit: number): Promise<AirtimeSandboxOrder[] | null>
    place(p: AirtimeSandboxPlaceParams): Promise<AirtimeSandboxPlaceResult>
  }
  now(): number
}

// ---------------------------------------------------------------- messages

export const AIRTIME_LIST_LIMIT = 30

export const MSG_AIRTIME_NOT_FOUND = "Order not found"
// The pending-outcome messages never promise the lookup resolves it and never suggest a new
// reference: a client that re-places the order under a new reference can be charged twice.
const PENDING_TAIL =
  "Do not place this order again under a new reference. Poll GET /airtime/orders/{reference}, whose claim.state reports it, or contact support quoting the reference"
export const MSG_REQUEST_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${PENDING_TAIL}`
export const MSG_PRIOR_OUTCOME_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${PENDING_TAIL}`
export const MSG_OUTCOME_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this purchase is not confirmed yet. ${PENDING_TAIL}`
export const MSG_CLAIM_UNAVAILABLE =
  "UNAVAILABLE: could not reserve this reference; nothing was charged. Retry with the same reference"
export const MSG_SANDBOX_UNAVAILABLE = "Sandbox is temporarily unavailable"
export const MSG_SANDBOX_FAILED = "Order could not be placed"

// Fixed, PII-free log lines.
const LOG_COMPLETE_FAILED = "[API v2] airtime: claim not finalised after a successful purchase (reads as unknown later)"
const LOG_RELEASE_FAILED = "[API v2] airtime: claim release failed (reference stays blocked)"
const LOG_UNKNOWN_FAILED = "[API v2] airtime: could not mark claim unknown (reads as unknown once stale)"
const LOG_AMBIGUOUS = "[API v2] airtime: ambiguous engine outcome; claim marked unknown"

const ERROR_STATUSES = new Set<number>([400, 401, 402, 403, 404, 409, 429, 500, 502, 503])

function fail(status: V2ErrorStatus, message: string): V2HandlerResult {
  return { status, error: { status, message } }
}

const ok = (status: number, data: unknown): V2HandlerResult => ({ status, data })

const notFound = () => fail(404, MSG_AIRTIME_NOT_FOUND)

// ---------------------------------------------------------------- helpers

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const money = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

const fixed2 = (v: unknown) => money(v).toFixed(2)

/** A stored public order re-read through the allow-list (extra keys never leave). */
function publicFromStored(s: unknown, reference: string): PublicAirtimeOrder {
  const r = isObject(s) ? s : {}
  return {
    reference,
    network: String(r.network ?? ""),
    recipient: String(r.recipient ?? ""),
    airtime_amount: money(r.airtime_amount),
    fee_amount: money(r.fee_amount),
    total_paid: money(r.total_paid),
    cashback: money(r.cashback),
    status: mapCommissionStatus(r.status),
    created_at: typeof r.created_at === "string" ? r.created_at : null,
  }
}

/** The stored order with its status refreshed from the owner-scoped live row; the stored order on any read failure. */
async function refreshedStored(
  deps: AirtimeDeps,
  userId: string,
  orderRef: string,
  stored: unknown,
  reference: string
): Promise<PublicAirtimeOrder> {
  const order = publicFromStored(stored, reference)
  let live: AirtimeOrderRow | null = null
  try {
    live = await deps.getOrderByCode(userId, orderRef)
  } catch {
    live = null
  }
  return live ? { ...order, status: mapCommissionStatus(live.status) } : order
}

function engineParams(ctx: V2Context, input: AirtimeInput): AirtimeEngineParams {
  return {
    userId: ctx.userId,
    network: input.engineNetwork,
    beneficiaryPhone: input.recipient.local,
    airtimeAmount: input.amount,
    // User ruling: the recipient always gets the full amount; without cashback the fee is charged on top.
    paySeparately: true,
    channel: "api",
    ...(input.expectedPay !== undefined ? { expectedPay: input.expectedPay } : {}),
  }
}

async function gateOk(deps: AirtimeDeps, userId: string): Promise<boolean> {
  try {
    return (await deps.phoneGate(userId)) === true
  } catch {
    return false
  }
}

async function safeRelease(deps: AirtimeDeps, claimId: string, userId: string): Promise<void> {
  let released = false
  try {
    released = await deps.release(claimId, userId)
  } catch {
    released = false
  }
  if (!released) console.error(LOG_RELEASE_FAILED)
}

async function safeMarkUnknown(deps: AirtimeDeps, claimId: string, userId: string, orderRef?: string): Promise<void> {
  let marked = false
  try {
    marked = orderRef ? await deps.markUnknown(claimId, userId, orderRef) : await deps.markUnknown(claimId, userId)
  } catch {
    marked = false
  }
  if (!marked) console.error(LOG_UNKNOWN_FAILED)
}

/** Best-effort URGENT admin alert; never throws and never changes the response. No phone numbers. */
async function safeAlert(deps: AirtimeDeps, message: string): Promise<void> {
  try {
    await deps.alert(message)
  } catch {
    // alerting must never break the flow
  }
}

/**
 * Ambiguous outcome: the claim becomes unknown (keeping the engine order when there is
 * one) and admins get an urgent alert carrying only the user id and the client reference.
 */
async function markAmbiguous(deps: AirtimeDeps, claimId: string, ctx: V2Context, reference: string, orderRef?: string): Promise<void> {
  await safeMarkUnknown(deps, claimId, ctx.userId, orderRef)
  await safeAlert(
    deps,
    `Airtime API outcome uncertain: claim ${reference}, user ${ctx.userId}${orderRef ? `, order ${orderRef}` : ""}. Check the wallet and the order before anything is resent.`
  )
}

/** No-charge engine error -> {status, message}; numbers travel in the message text. */
function noChargeResult(e: unknown): V2HandlerResult {
  const r = airtimeErrorResponse(e)
  const status = (ERROR_STATUSES.has(r.status) ? r.status : 500) as V2ErrorStatus
  if (r.code === "INSUFFICIENT_BALANCE") {
    return fail(
      status,
      r.required !== undefined
        ? `INSUFFICIENT_BALANCE: wallet balance is too low; required ${r.required.toFixed(2)}`
        : "INSUFFICIENT_BALANCE: wallet balance is too low"
    )
  }
  if (r.code === "PRICE_CHANGED" && r.quote) {
    return fail(
      status,
      `PRICE_CHANGED: the price has changed; face_amount ${fixed2(r.quote.face_amount)}, pay_amount ${fixed2(
        r.quote.pay_amount
      )}, customer_cashback ${fixed2(r.quote.customer_cashback)}. Review the price and resend with expected_pay`
    )
  }
  return fail(status, `${r.code}: ${r.message}`)
}

function engineCode(e: unknown): unknown {
  return isObject(e) || e instanceof Error ? (e as { code?: unknown }).code : undefined
}

// ---------------------------------------------------------------- purchase

export function purchaseAirtimeHandler(deps: AirtimeDeps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const parsed = parseAirtimeBody(body)
    if (!parsed.ok) return fail(400, parsed.error)
    const input = parsed.value
    if (ctx.environment !== "test") return livePurchase(deps, input, ctx)
    try {
      return await sandboxPurchase(deps, input, ctx)
    } catch {
      return fail(500, MSG_SANDBOX_UNAVAILABLE)
    }
  }
}

async function livePurchase(deps: AirtimeDeps, input: AirtimeInput, ctx: V2Context): Promise<V2HandlerResult> {
  // 1. Claim the reference BEFORE anything that can charge. Decides replays too.
  let outcome: ClaimOutcome
  try {
    outcome = await deps.claim({
      userId: ctx.userId,
      apiV2KeyId: ctx.keyId,
      kind: "airtime",
      reference: input.reference,
      requestHash: airtimeHash(input),
    })
  } catch {
    outcome = { kind: "error" }
  }
  switch (outcome.kind) {
    case "replay":
      return ok(200, { order: await refreshedStored(deps, ctx.userId, outcome.orderRef, outcome.response, input.reference), replayed: true })
    case "conflict":
      return fail(409, MSG_REFERENCE_REUSED)
    case "in_progress":
      return fail(409, MSG_REQUEST_IN_PROGRESS)
    case "unknown":
      return fail(409, MSG_PRIOR_OUTCOME_UNKNOWN)
    case "claimed":
      break
    default:
      return fail(503, MSG_CLAIM_UNAVAILABLE)
  }
  const claimId = outcome.claimId

  // 2. Account phone gate (fail closed). A block frees the reference: nothing was charged.
  if (!(await gateOk(deps, ctx.userId))) {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(403, MSG_PHONE_GATE)
  }

  // 3. The engine. Only classified no-charge codes free the reference.
  let result: AirtimeEngineResult
  try {
    result = await deps.engine(engineParams(ctx, input))
  } catch (e) {
    if (classifyEngineError(engineCode(e)) === "no_charge") {
      await safeRelease(deps, claimId, ctx.userId)
      return noChargeResult(e)
    }
    await markAmbiguous(deps, claimId, ctx, input.reference)
    console.error(LOG_AMBIGUOUS)
    return fail(500, MSG_OUTCOME_UNKNOWN)
  }

  const code = result?.order?.reference_code
  if (typeof code !== "string" || !code) {
    // The engine returned without a usable order: money may have moved.
    await markAmbiguous(deps, claimId, ctx, input.reference)
    console.error(LOG_AMBIGUOUS)
    return fail(500, MSG_OUTCOME_UNKNOWN)
  }

  // 4. Success. The engine result lacks cashback and created_at: read the row
  //    back (owner-scoped, best effort), else map the engine row as is.
  let row: AirtimeOrderRow | null = null
  try {
    row = await deps.getOrderByCode(ctx.userId, code)
  } catch {
    row = null
  }
  const order = row
    ? mapAirtimeOrder(row, input.reference)
    : mapAirtimeOrder({ ...result.order, created_at: new Date(deps.now()).toISOString() }, input.reference)

  let completed = false
  try {
    completed = await deps.complete(claimId, code, order, ctx.userId)
  } catch {
    completed = false
  }
  // The money moved: answer 201 regardless. Fall back to unknown WITH the engine order so the
  // claim keeps the order link (never re-run), and alert admins.
  if (!completed) {
    console.error(LOG_COMPLETE_FAILED)
    await markAmbiguous(deps, claimId, ctx, input.reference, code)
  }

  const nb = Number(result.newBalance)
  return ok(201, { order, new_balance: Number.isFinite(nb) ? money(nb) : null })
}

// ---------------------------------------------------------------- sandbox

function sandboxResponse(prior: AirtimeSandboxOrder): Record<string, unknown> {
  return isObject(prior.response) ? prior.response : {}
}

function sandboxMatches(input: AirtimeInput, prior: AirtimeSandboxOrder): boolean {
  if (prior.action !== "airtime") return false
  const r = sandboxResponse(prior)
  const net = parseAirtimeNetwork(r.network)
  if (!net.ok || net.network !== input.network) return false
  const rec = normalizeRecipient(r.recipient)
  if (!rec.ok || rec.local !== input.recipient.local) return false
  const amt = parseAmountPesewas(r.airtime_amount)
  return amt.ok && amt.pesewas === input.pesewas
}

function mapSandboxOrder(prior: AirtimeSandboxOrder): PublicAirtimeOrder {
  const r = sandboxResponse(prior)
  return mapAirtimeOrder(
    {
      network: r.network,
      beneficiary_phone: r.recipient,
      airtime_amount: r.airtime_amount,
      fee_amount: r.fee_amount,
      total_paid: r.total_paid,
      cashback_amount: r.cashback,
      status: prior.status,
      created_at: prior.created_at,
    },
    prior.reference
  )
}

async function sandboxPurchase(deps: AirtimeDeps, input: AirtimeInput, ctx: V2Context): Promise<V2HandlerResult> {
  const replay = (prior: AirtimeSandboxOrder) => ok(200, { order: mapSandboxOrder(prior), replayed: true, sandbox: true })

  const prior = await deps.sandbox.getOrder(ctx.userId, input.reference)
  if (prior) return sandboxMatches(input, prior) ? replay(prior) : fail(409, MSG_REFERENCE_REUSED)

  const recipient = input.recipient.local
  const placed = await deps.sandbox.place({
    userId: ctx.userId,
    apiV2KeyId: ctx.keyId,
    action: "airtime",
    reference: input.reference,
    request: { network: input.network, recipient, amount: input.amount, reference: input.reference },
    price: input.amount,
    orderFields: { network: input.network, recipient, airtime_amount: input.amount, fee_amount: 0, total_paid: input.amount, cashback: 0 },
  })
  if (!placed.success) {
    if (placed.status === 402) {
      return fail(402, `INSUFFICIENT_BALANCE: test balance is too low; required ${input.amount.toFixed(2)}`)
    }
    if (placed.status === 409) {
      // Insert race: answer as a replay when it is the same order.
      const again = await deps.sandbox.getOrder(ctx.userId, input.reference)
      if (again && sandboxMatches(input, again)) return replay(again)
      return fail(409, MSG_REFERENCE_REUSED)
    }
    return fail(500, MSG_SANDBOX_FAILED)
  }
  const o = placed.order
  const order = mapAirtimeOrder(
    {
      network: input.network,
      beneficiary_phone: recipient,
      airtime_amount: input.amount,
      fee_amount: 0,
      total_paid: input.amount,
      cashback_amount: 0,
      status: o.status ?? "pending",
      created_at: typeof o.created_at === "string" ? o.created_at : new Date(deps.now()).toISOString(),
    },
    input.reference
  )
  return ok(201, { order, new_balance: placed.newBalance, sandbox: true })
}

// ---------------------------------------------------------------- lookup

export function airtimeOrderHandler(deps: AirtimeDeps) {
  return async (reference: string, ctx: V2Context): Promise<V2HandlerResult> => {
    // Malformed, missing, foreign, in-progress and unknown all get this one body.
    const ref = parseReference(reference)
    if (!ref.ok) return notFound()

    if (ctx.environment === "test") {
      let prior: AirtimeSandboxOrder | null
      try {
        prior = await deps.sandbox.getOrder(ctx.userId, ref.reference)
      } catch {
        return fail(500, MSG_SANDBOX_UNAVAILABLE)
      }
      if (!prior || prior.action !== "airtime") return notFound()
      return ok(200, { order: mapSandboxOrder(prior), claim: null, sandbox: true })
    }

    let claim: Awaited<ReturnType<AirtimeDeps["getClaim"]>>
    try {
      claim = await deps.getClaim(ctx.userId, ref.reference)
    } catch {
      claim = null
    }
    if (!claim) return notFound()
    // The caller's own claim that is still running or ambiguous: say so (never a 404, which reads as "never created").
    const pending = mapClaimState(claim, ref.reference, deps.now())
    if (pending) return ok(200, { order: null, claim: pending })
    if (claim.status !== "done" || !claim.orderRef) return notFound()

    let live: AirtimeOrderRow | null = null
    try {
      live = await deps.getOrderByCode(ctx.userId, claim.orderRef)
    } catch {
      live = null
    }
    if (!isObject(claim.response)) {
      return live ? ok(200, { order: mapAirtimeOrder(live, ref.reference), claim: null }) : notFound()
    }
    const stored = publicFromStored(claim.response, ref.reference)
    return ok(200, { order: live ? { ...stored, status: mapCommissionStatus(live.status) } : stored, claim: null })
  }
}

// ---------------------------------------------------------------- list

export function airtimeListHandler(deps: AirtimeDeps) {
  return async (ctx: V2Context): Promise<V2HandlerResult> => {
    if (ctx.environment === "test") {
      let rows: AirtimeSandboxOrder[] | null
      try {
        rows = await deps.sandbox.listOrders(ctx.userId, "airtime", AIRTIME_LIST_LIMIT)
      } catch {
        return fail(500, MSG_SANDBOX_UNAVAILABLE)
      }
      if (!rows) return fail(503, MSG_UNAVAILABLE)
      const orders = rows
        .filter((r) => r.action === "airtime")
        .slice(0, AIRTIME_LIST_LIMIT)
        .map(mapSandboxOrder)
      return ok(200, { orders, sandbox: true })
    }

    let claims: Awaited<ReturnType<AirtimeDeps["listClaims"]>>
    try {
      claims = await deps.listClaims(ctx.userId, AIRTIME_LIST_LIMIT)
    } catch {
      return fail(503, MSG_UNAVAILABLE)
    }
    // null = the claim store could not be read: fail closed (503), never an empty 200.
    if (!Array.isArray(claims)) return fail(503, MSG_UNAVAILABLE)
    const done = claims
      .slice(0, AIRTIME_LIST_LIMIT)
      .filter((c): c is { reference: string; orderRef: string; status: string } => c.status === "done" && !!c.orderRef)
    if (done.length === 0) return ok(200, { orders: [] })

    let rows: AirtimeOrderRow[] | null
    try {
      rows = await deps.getOrdersByCodes(
        ctx.userId,
        done.map((c) => c.orderRef)
      )
    } catch {
      rows = null
    }
    if (!rows) return fail(503, MSG_UNAVAILABLE)
    const byCode = new Map(rows.map((r) => [r.reference_code, r]))
    const orders = done.flatMap((c) => {
      const row = byCode.get(c.orderRef)
      return row ? [mapAirtimeOrder(row, c.reference)] : []
    })
    return ok(200, { orders })
  }
}
