/**
 * Developer API v2 utility bills endpoints (commission key): billers list,
 * account lookup, payment, order lookup. MONEY PATH (tier 1): payment moves
 * wallet money through the shared engine payBill (lib/bills/service.ts).
 *
 * Every decision lives here, over injected BillsV2Deps, so tests need no
 * network. Routes only wire real deps (bills-deps.ts) and withV2. Mirrors
 * airtime.ts.
 *
 * Live payment order (each step short-circuits):
 *   parse body (price-like fields rejected, sandbox token refused; no I/O) -> claim
 *     replay      => 200 { order, replayed: true }   (no gate, no engine)
 *     conflict    => 409 REFERENCE_REUSED
 *     in_progress => 409 REQUEST_IN_PROGRESS
 *     unknown     => 409 OUTCOME_UNKNOWN
 *     error       => 503 (fail closed, retryable)
 *   -> API surface gate (closed or unreadable: release the claim, 403)
 *   -> account phone gate (block or throw: release the claim, 403)
 *   -> payBill(channel "api")
 *     ok, order inserted by THIS call  => complete the claim, 201 { order }
 *     ok, an EARLIER order of the token => release, 409 (one verify_token pays one reference)
 *     refused with status < 500 or 503  => release, mapped (payBill never debits on these)
 *     any other 5xx / throw / malformed => mark the claim unknown, generic 500
 *
 * Why "inserted by this call" and not only "no other claim links the order":
 * payBill's API retry path hands back the token's earlier order. While that
 * earlier request is still dispatching (seconds, inside payBill) its claim has
 * no order_ref yet, so a claim lookup alone would let a second reference
 * complete against the same single payment. The real wiring reports `fresh`
 * (bills-deps.ts wraps insertOrder); only a fresh order debited in this call.
 *
 * Messages are fixed strings with the machine code as a prefix; engine text,
 * account numbers, tokens and bodies are never echoed or logged.
 */
import type { V2Context, V2HandlerResult } from "../handler"
import type { V2ErrorStatus } from "../envelope"
import type { ClaimOutcome } from "../idempotency"
import {
  billErrorResponse,
  billHash,
  mapBillOrder,
  mapCommissionStatus,
  parseAmountPesewas,
  parseBillLookupBody,
  parseBillPayBody,
  type BillPayInput,
  type PublicBillOrder,
} from "../commission"
import { parseReference } from "../data-orders"
import { BILLER_KEYS, BILLERS, type BillerKey } from "@/lib/bills/billers"
import type { BillsConfig } from "@/lib/bills/config"
import type { PayResult, VerifyResult } from "@/lib/bills/service"
import { parseSandboxToken, sandboxBillReference, sandboxVerify, verifyResponse, type ParsedVerifyBody } from "@/lib/api-v1/bills"
import { MSG_PHONE_GATE, MSG_REFERENCE_REUSED } from "./data"
import { MSG_CLAIM_UNAVAILABLE } from "./airtime"

// ---------------------------------------------------------------- deps

/** Exactly what v2 hands payBill. */
export interface BillPayEngineParams {
  userId: string
  verifyToken: string
  amount: number
  expectedPay?: number
  channel: "api"
}

/** payBill's result plus whether the returned order was inserted (and so debited) by this very call. */
export interface BillPayEngineResult {
  result: PayResult
  fresh: boolean
}

/** The allow-listed hubtel_bill_orders columns v2 selects (filtered by user_id). */
export interface BillOrderV2Row {
  reference_code: string
  biller: string
  account_number: string
  customer_name: string | null
  amount: number | string
  paid_amount: number | string | null
  cashback_amount: number | string | null
  status: string
  created_at: string
}

/** What lib/sandbox.ts getSandboxOrder returns. */
export interface BillSandboxOrder {
  reference: string
  action: string
  response: unknown
  price: number | string
  created_at: string
  status: string
}

export interface BillSandboxPlaceParams {
  userId: string
  apiV2KeyId: string
  action: "utility_bill"
  reference: string
  request: Record<string, unknown>
  price: number
  orderFields: Record<string, unknown>
}

export type BillSandboxPlaceResult =
  | { success: true; order: Record<string, unknown>; newBalance: number }
  | { success: false; error: string; status: number }

export interface BillsV2Deps {
  claim(p: { userId: string; apiV2KeyId: string; kind: "bill"; reference: string; requestHash: string }): Promise<ClaimOutcome>
  /** Each finalisation is owner-guarded: callers always pass ctx.userId. */
  complete(claimId: string, orderRef: string, response: unknown, userId: string): Promise<boolean>
  release(claimId: string, userId: string): Promise<boolean>
  markUnknown(claimId: string, userId: string): Promise<boolean>
  getClaim(userId: string, reference: string): Promise<{ orderRef: string | null; status: string; response: unknown } | null>
  /** Owner's bill claims linked to an engine order; null on a read error. */
  findClaimByOrderRef(userId: string, orderRef: string): Promise<{ reference: string; status: string }[] | null>
  /** The admin API surface switch (readApiSurface); only `true` opens. */
  surfaceOpen(): Promise<boolean>
  /** Account phone gate; only `true` passes, a throw is a block. */
  phoneGate(userId: string): Promise<boolean>
  getBillsConfig(): Promise<BillsConfig>
  verify(userId: string, biller: BillerKey, inputs: ParsedVerifyBody["inputs"]): Promise<VerifyResult>
  pay(p: BillPayEngineParams): Promise<BillPayEngineResult>
  /** Owner-scoped; null when missing or unreadable. */
  getOrderByCode(userId: string, code: string): Promise<BillOrderV2Row | null>
  sandbox: {
    getOrder(userId: string, reference: string): Promise<BillSandboxOrder | null>
    /** v2 sandbox bill orders already paid with this token (response.token_ref); null on a read error. */
    findByTokenRef(userId: string, tokenRef: string): Promise<{ reference: string }[] | null>
    place(p: BillSandboxPlaceParams): Promise<BillSandboxPlaceResult>
  }
  now(): number
}

// ---------------------------------------------------------------- messages

export const MSG_BILL_NOT_FOUND = "Order not found"
export const MSG_TOKEN_REUSED = "REFERENCE_REUSED: this verification already paid another reference"
export const MSG_BILL_IN_PROGRESS =
  "REQUEST_IN_PROGRESS: a request with this reference is still being processed; check GET /utilities/orders/{reference} shortly"
export const MSG_BILL_PRIOR_UNKNOWN =
  "OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is unknown; do not resend with a new reference. Check GET /utilities/orders/{reference} or contact support"
export const MSG_BILL_OUTCOME_UNKNOWN =
  "OUTCOME_UNKNOWN: the outcome of this payment is unknown; do not resend with a new reference. Check GET /utilities/orders/{reference} or contact support"
export const MSG_BILLS_NOT_AVAILABLE = "NOT_AVAILABLE: utility bills are not available on the API right now"
export const MSG_VERIFY_AGAIN =
  "VERIFY_AGAIN: this verification can no longer be used; nothing was charged. Verify the account again with POST /utilities/lookup"
export const MSG_INVALID_TOKEN = "INVALID_TOKEN: the verify_token is invalid or expired; nothing was charged. Verify the account again"
export const MSG_SANDBOX_TOKEN_ON_LIVE =
  "INVALID_TOKEN: this is a sandbox verify_token; a live key needs a token from POST /utilities/lookup made with a live key"
export const MSG_TOKEN_ON_TEST_KEY =
  "INVALID_TOKEN: a test key needs a sandbox verify_token from POST /utilities/lookup made with a test key"
export const MSG_INVALID_AMOUNT =
  "INVALID_AMOUNT: the amount is outside this biller's allowed range or precision (see GET /utilities/billers); nothing was charged"
export const MSG_PAY_INVALID = "INVALID_REQUEST: the payment was refused; nothing was charged"
export const MSG_INSUFFICIENT = "INSUFFICIENT_BALANCE: wallet balance is too low; nothing was charged"
export const MSG_BILLER_UNAVAILABLE = "BILLER_UNAVAILABLE: this biller is currently unavailable; nothing was charged"
export const MSG_BILLS_UNAVAILABLE = "UNAVAILABLE: utility bills are temporarily unavailable; nothing was charged"
export const MSG_PAY_INTERNAL = "INTERNAL_ERROR: the payment could not be started; nothing was charged"
export const MSG_LOOKUP_INVALID =
  "INVALID_REQUEST: the account details are not valid for this biller (see GET /utilities/billers for the required inputs)"
export const MSG_LOOKUP_BILLER_UNAVAILABLE = "BILLER_UNAVAILABLE: this biller is currently unavailable"
export const MSG_LOOKUP_UNAVAILABLE = "UNAVAILABLE: utility bills are temporarily unavailable"
export const MSG_LOOKUP_FAILED = "LOOKUP_FAILED: the biller could not verify this account; check the details and retry"
export const MSG_LOOKUP_INTERNAL = "INTERNAL_ERROR: the account could not be verified"
export const MSG_BILLERS_UNAVAILABLE = "UNAVAILABLE: the biller list is temporarily unavailable"
const MSG_SANDBOX_FAILED = "Order could not be placed"
const MSG_SANDBOX_CHECK_FAILED = "UNAVAILABLE: could not check earlier test payments; nothing was charged"

// Fixed, PII-free log lines.
const LOG_COMPLETE_FAILED = "[API v2] bills: claim not finalised after a successful payment (reads as unknown later)"
const LOG_RELEASE_FAILED = "[API v2] bills: claim release failed (reference stays blocked)"
const LOG_UNKNOWN_FAILED = "[API v2] bills: could not mark claim unknown (reads as unknown once stale)"
const LOG_AMBIGUOUS = "[API v2] bills: ambiguous engine outcome; claim marked unknown"
const LOG_TOKEN_REUSED = "[API v2] bills: verify token already paid an earlier order; claim released"
const LOG_LOOKUP_FAILED = "[API v2] bills: account lookup failed"
const LOG_BILLERS_FAILED = "[API v2] bills: biller config unavailable"

const SANDBOX_TOKEN_PREFIX = "sandbox_bill."

function fail(status: V2ErrorStatus, message: string): V2HandlerResult {
  return { status, error: { status, message } }
}

const ok = (status: number, data: unknown): V2HandlerResult => ({ status, data })

const notFound = () => fail(404, MSG_BILL_NOT_FOUND)

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
function publicFromStored(s: unknown, reference: string): PublicBillOrder {
  const r = isObject(s) ? s : {}
  return {
    reference,
    biller: String(r.biller ?? ""),
    account: String(r.account ?? ""),
    customer_name: typeof r.customer_name === "string" ? r.customer_name : null,
    face_amount: money(r.face_amount),
    paid_amount: money(r.paid_amount ?? r.face_amount),
    cashback: money(r.cashback),
    status: mapCommissionStatus(r.status),
    created_at: typeof r.created_at === "string" ? r.created_at : null,
  }
}

/** v1's verifyResponse minus its `success` flag (the v2 envelope carries success). */
function lookupBody(r: Parameters<typeof verifyResponse>[0] | ReturnType<typeof verifyResponse>): Record<string, unknown> {
  const body: Record<string, unknown> = "success" in r ? { ...r } : { ...verifyResponse(r) }
  delete body.success
  return body
}

async function truthy(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await fn()) === true
  } catch {
    return false
  }
}

async function safeRelease(deps: BillsV2Deps, claimId: string, userId: string): Promise<void> {
  let released = false
  try {
    released = await deps.release(claimId, userId)
  } catch {
    released = false
  }
  if (!released) console.error(LOG_RELEASE_FAILED)
}

async function safeMarkUnknown(deps: BillsV2Deps, claimId: string, userId: string): Promise<void> {
  let marked = false
  try {
    marked = await deps.markUnknown(claimId, userId)
  } catch {
    marked = false
  }
  if (!marked) console.error(LOG_UNKNOWN_FAILED)
}

function priceChangedMessage(expected: number | undefined, quote: { face_amount: number; pay_amount: number; customer_cashback: number }) {
  const exp = expected !== undefined ? `expected ${fixed2(expected)}, ` : ""
  return `PRICE_CHANGED: ${exp}current ${fixed2(quote.pay_amount)} (face_amount ${fixed2(quote.face_amount)}, customer_cashback ${fixed2(
    quote.customer_cashback
  )}). Review the price and resend with expected_pay`
}

/**
 * A payBill refusal that never debited (every status < 500, and 503 which only
 * the pre-insert gates return) -> fixed {status, message}.
 */
function refusalResult(r: { status: number; error: string; quote?: unknown }, expectedPay: number | undefined): V2HandlerResult {
  if (r.status === 409 && r.quote) {
    const q = billErrorResponse({ ok: false, status: 409, error: r.error, quote: r.quote }).quote
    if (q) return fail(409, priceChangedMessage(expectedPay, q))
  }
  switch (r.status) {
    case 400: {
      const e = typeof r.error === "string" ? r.error : ""
      if (e === "Please verify the account again") return fail(400, MSG_INVALID_TOKEN)
      if (/^(Amount |Enter a valid amount)/.test(e)) return fail(400, MSG_INVALID_AMOUNT)
      return fail(400, MSG_PAY_INVALID)
    }
    case 402:
      return fail(402, MSG_INSUFFICIENT)
    case 403:
      return fail(503, MSG_BILLER_UNAVAILABLE)
    case 409:
      return fail(409, MSG_VERIFY_AGAIN)
    case 503:
      return fail(503, MSG_BILLS_UNAVAILABLE)
    default:
      return fail(500, MSG_PAY_INTERNAL)
  }
}

/** payBill statuses that are known to happen with no debit (see lib/bills/service.ts payBill). */
const isNoDebitStatus = (s: number) => (s >= 400 && s < 500) || s === 503

// ---------------------------------------------------------------- pay

export function billPayHandler(deps: BillsV2Deps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const parsed = parseBillPayBody(body)
    if (!parsed.ok) return fail(400, parsed.error)
    const input = parsed.value
    if (ctx.environment === "test") return sandboxPay(deps, input, ctx)
    if (input.verifyToken.startsWith(SANDBOX_TOKEN_PREFIX)) return fail(400, MSG_SANDBOX_TOKEN_ON_LIVE)
    return livePay(deps, input, ctx)
  }
}

async function livePay(deps: BillsV2Deps, input: BillPayInput, ctx: V2Context): Promise<V2HandlerResult> {
  // 1. Claim the reference BEFORE anything that can charge. Decides replays too.
  let outcome: ClaimOutcome
  try {
    outcome = await deps.claim({
      userId: ctx.userId,
      apiV2KeyId: ctx.keyId,
      kind: "bill",
      reference: input.reference,
      requestHash: billHash(input),
    })
  } catch {
    outcome = { kind: "error" }
  }
  switch (outcome.kind) {
    case "replay":
      return ok(200, { order: publicFromStored(outcome.response, input.reference), replayed: true })
    case "conflict":
      return fail(409, MSG_REFERENCE_REUSED)
    case "in_progress":
      return fail(409, MSG_BILL_IN_PROGRESS)
    case "unknown":
      return fail(409, MSG_BILL_PRIOR_UNKNOWN)
    case "claimed":
      break
    default:
      return fail(503, MSG_CLAIM_UNAVAILABLE)
  }
  const claimId = outcome.claimId

  // 2. API surface switch (fail closed). A block frees the reference: nothing was charged.
  if (!(await truthy(() => deps.surfaceOpen()))) {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(403, MSG_BILLS_NOT_AVAILABLE)
  }

  // 3. Account phone gate (fail closed).
  if (!(await truthy(() => deps.phoneGate(ctx.userId)))) {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(403, MSG_PHONE_GATE)
  }

  // 4. The engine.
  let paid: BillPayEngineResult
  try {
    paid = await deps.pay({
      userId: ctx.userId,
      verifyToken: input.verifyToken,
      amount: input.amount,
      ...(input.expectedPay !== undefined ? { expectedPay: input.expectedPay } : {}),
      channel: "api",
    })
  } catch {
    return ambiguous(deps, claimId, ctx.userId)
  }
  const result = isObject(paid) ? (paid.result as PayResult | undefined) : undefined
  if (!isObject(result) || typeof result.ok !== "boolean") return ambiguous(deps, claimId, ctx.userId)

  if (!result.ok) {
    if (typeof result.status === "number" && isNoDebitStatus(result.status)) {
      await safeRelease(deps, claimId, ctx.userId)
      return refusalResult(result, input.expectedPay)
    }
    return ambiguous(deps, claimId, ctx.userId)
  }

  const order = result.order
  // 5. An order this call did not insert is the token's EARLIER order (payBill's API retry
  //    path): this request debited nothing, and that payment belongs to another reference.
  if (paid.fresh !== true) {
    await safeRelease(deps, claimId, ctx.userId)
    console.error(LOG_TOKEN_REUSED)
    return tokenReuseResult(deps, ctx.userId, order)
  }

  const code = order?.reference_code
  if (typeof code !== "string" || !code) return ambiguous(deps, claimId, ctx.userId)

  // 6. Success: store the engine code as order_ref and the allow-listed order as the response.
  const pub = mapBillOrder(order, input.reference)
  let completed = false
  try {
    completed = await deps.complete(claimId, code, pub, ctx.userId)
  } catch {
    completed = false
  }
  // The money moved: answer 201 regardless. An unfinalised claim reads as unknown later (never re-run).
  if (!completed) console.error(LOG_COMPLETE_FAILED)
  return ok(201, { order: pub })
}

async function ambiguous(deps: BillsV2Deps, claimId: string, userId: string): Promise<V2HandlerResult> {
  await safeMarkUnknown(deps, claimId, userId)
  console.error(LOG_AMBIGUOUS)
  return fail(500, MSG_BILL_OUTCOME_UNKNOWN)
}

/** The claim is already released. Paid (or linked to another claim, or unreadable) => REFERENCE_REUSED. */
async function tokenReuseResult(deps: BillsV2Deps, userId: string, order: { reference_code?: unknown; payment_status?: unknown } | undefined) {
  const code = typeof order?.reference_code === "string" ? order.reference_code : ""
  let claims: { reference: string; status: string }[] | null = null
  if (code) {
    try {
      claims = await deps.findClaimByOrderRef(userId, code)
    } catch {
      claims = null
    }
  }
  const unpaidAndUnlinked = order?.payment_status !== "paid" && Array.isArray(claims) && claims.length === 0
  return fail(409, unpaidAndUnlinked ? MSG_VERIFY_AGAIN : MSG_TOKEN_REUSED)
}

// ---------------------------------------------------------------- sandbox pay

function sandboxResponse(prior: BillSandboxOrder): Record<string, unknown> {
  return isObject(prior.response) ? prior.response : {}
}

function sandboxMatches(input: BillPayInput, tokenRef: string, prior: BillSandboxOrder): boolean {
  if (prior.action !== "utility_bill") return false
  const r = sandboxResponse(prior)
  if (r.token_ref !== tokenRef) return false
  const amt = parseAmountPesewas(r.face_amount, { max: 1_000_000 })
  return amt.ok && amt.pesewas === input.pesewas
}

function mapSandboxOrder(prior: BillSandboxOrder): PublicBillOrder {
  const r = sandboxResponse(prior)
  return mapBillOrder(
    {
      biller: r.biller,
      account_number: r.account,
      customer_name: r.customer_name,
      amount: r.face_amount,
      paid_amount: r.paid_amount,
      cashback_amount: r.cashback,
      status: prior.status,
      created_at: prior.created_at,
    },
    prior.reference
  )
}

async function sandboxPay(deps: BillsV2Deps, input: BillPayInput, ctx: V2Context): Promise<V2HandlerResult> {
  const t = input.verifyToken.startsWith(SANDBOX_TOKEN_PREFIX) ? parseSandboxToken(ctx.userId, input.verifyToken) : null
  if (!t) return fail(400, MSG_TOKEN_ON_TEST_KEY)
  const tokenRef = sandboxBillReference(input.verifyToken)
  const replay = (prior: BillSandboxOrder) => ok(200, { order: mapSandboxOrder(prior), replayed: true, sandbox: true })

  // Replay is keyed by the CLIENT reference.
  const prior = await deps.sandbox.getOrder(ctx.userId, input.reference)
  if (prior) return sandboxMatches(input, tokenRef, prior) ? replay(prior) : fail(409, MSG_REFERENCE_REUSED)

  // A sandbox token pays one order, like live: a v1 order (deterministic reference) or a v2 order under another reference.
  const v1Prior = await deps.sandbox.getOrder(ctx.userId, tokenRef)
  if (v1Prior && v1Prior.action === "utility_bill") return fail(409, MSG_TOKEN_REUSED)
  const others = await deps.sandbox.findByTokenRef(ctx.userId, tokenRef)
  if (others === null) return fail(503, MSG_SANDBOX_CHECK_FAILED)
  if (others.some((o) => o.reference !== input.reference)) return fail(409, MSG_TOKEN_REUSED)

  // Sandbox charges face value (no cashback).
  const price = input.amount
  if (input.expectedPay !== undefined && Math.round(input.expectedPay * 100) !== input.pesewas) {
    return fail(409, priceChangedMessage(input.expectedPay, { face_amount: price, pay_amount: price, customer_cashback: 0 }))
  }

  const placed = await deps.sandbox.place({
    userId: ctx.userId,
    apiV2KeyId: ctx.keyId,
    action: "utility_bill",
    reference: input.reference,
    request: { biller: t.biller, account: t.account, amount: price, token_ref: tokenRef, reference: input.reference },
    price,
    orderFields: {
      biller: t.biller,
      account: t.account,
      customer_name: "Sandbox Customer",
      payment_status: "paid",
      face_amount: price,
      paid_amount: price,
      cashback: 0,
      token_ref: tokenRef,
    },
  })
  if (!placed.success) {
    if (placed.status === 402) return fail(402, `INSUFFICIENT_BALANCE: test balance is too low; required ${fixed2(price)}`)
    if (placed.status === 409) {
      // Insert race: answer as a replay when it is the same order.
      const again = await deps.sandbox.getOrder(ctx.userId, input.reference)
      if (again && sandboxMatches(input, tokenRef, again)) return replay(again)
      return fail(409, MSG_REFERENCE_REUSED)
    }
    return fail(500, MSG_SANDBOX_FAILED)
  }
  const o = placed.order
  const order = mapBillOrder(
    {
      biller: t.biller,
      account_number: t.account,
      customer_name: "Sandbox Customer",
      amount: price,
      paid_amount: price,
      cashback_amount: 0,
      status: o.status ?? "pending",
      created_at: typeof o.created_at === "string" ? o.created_at : new Date(deps.now()).toISOString(),
    },
    input.reference
  )
  return ok(201, { order, sandbox: true })
}

// ---------------------------------------------------------------- lookup

/** verifyBill failure -> fixed message (engine/provider text is never forwarded). */
function lookupFailure(status: number): V2HandlerResult {
  switch (status) {
    case 400:
      return fail(400, MSG_LOOKUP_INVALID)
    case 403:
      return fail(503, MSG_LOOKUP_BILLER_UNAVAILABLE)
    case 503:
      return fail(503, MSG_LOOKUP_UNAVAILABLE)
    case 422:
      return fail(502, MSG_LOOKUP_FAILED)
    default:
      return fail(500, MSG_LOOKUP_INTERNAL)
  }
}

export function billLookupHandler(deps: BillsV2Deps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const parsed = parseBillLookupBody(body)
    if (!parsed.ok) return fail(400, parsed.error)

    if (ctx.environment === "test") {
      const r = sandboxVerify(ctx.userId, parsed.biller, parsed.inputs)
      if (!r.ok) return fail(400, MSG_LOOKUP_INVALID)
      return ok(200, { ...lookupBody(r.body), sandbox: true })
    }

    // No phone gate: a lookup moves no money. The surface switch still applies (fail closed).
    if (!(await truthy(() => deps.surfaceOpen()))) return fail(403, MSG_BILLS_NOT_AVAILABLE)

    let result: VerifyResult
    try {
      result = await deps.verify(ctx.userId, parsed.biller, parsed.inputs)
    } catch {
      console.error(LOG_LOOKUP_FAILED)
      return fail(500, MSG_LOOKUP_INTERNAL)
    }
    if (!isObject(result)) return fail(500, MSG_LOOKUP_INTERNAL)
    if (!result.ok) return lookupFailure(result.status)
    return ok(200, lookupBody(result))
  }
}

// ---------------------------------------------------------------- billers

export interface BillerInput {
  name: "account" | "phone" | "email" | "broadband_account" | "add_meter" | "consent"
  required: boolean
}

/** The lookup fields each biller needs (mirrors normaliseInputs in lib/bills/billers.ts). */
const BILLER_INPUTS: Record<BillerKey, BillerInput[]> = {
  ecg: [
    { name: "phone", required: true },
    { name: "account", required: false },
    { name: "add_meter", required: false },
    { name: "consent", required: false },
  ],
  ghana_water: [
    { name: "account", required: true },
    { name: "phone", required: true },
    { name: "email", required: true },
  ],
  dstv: [{ name: "account", required: true }],
  gotv: [{ name: "account", required: true }],
  startimes: [{ name: "account", required: true }],
  telecel_broadband: [
    { name: "account", required: true },
    { name: "broadband_account", required: true },
  ],
}

export function billersHandler(deps: BillsV2Deps) {
  return async (_ctx: V2Context): Promise<V2HandlerResult> => {
    let cfg: BillsConfig
    try {
      cfg = await deps.getBillsConfig()
    } catch {
      console.error(LOG_BILLERS_FAILED)
      return fail(503, MSG_BILLERS_UNAVAILABLE)
    }
    if (!isObject(cfg)) return fail(503, MSG_BILLERS_UNAVAILABLE)
    const billers = BILLER_KEYS.map((key) => {
      const s = isObject(cfg.billers) && isObject(cfg.billers[key]) ? cfg.billers[key] : null
      return {
        key,
        label: BILLERS[key].label,
        enabled: cfg.enabled === true && s?.enabled === true,
        min_amount: s ? money(s.min) : null,
        max_amount: s ? money(s.max) : null,
        inputs: BILLER_INPUTS[key].map((i) => ({ ...i })),
      }
    })
    return ok(200, { billers })
  }
}

// ---------------------------------------------------------------- order lookup

export function billOrderHandler(deps: BillsV2Deps) {
  return async (reference: string, ctx: V2Context): Promise<V2HandlerResult> => {
    // Malformed, missing, foreign, in-progress and unknown all get this one body.
    const ref = parseReference(reference)
    if (!ref.ok) return notFound()

    if (ctx.environment === "test") {
      const prior = await deps.sandbox.getOrder(ctx.userId, ref.reference)
      if (!prior || prior.action !== "utility_bill") return notFound()
      return ok(200, { order: mapSandboxOrder(prior), sandbox: true })
    }

    let claim: Awaited<ReturnType<BillsV2Deps["getClaim"]>>
    try {
      claim = await deps.getClaim(ctx.userId, ref.reference)
    } catch {
      claim = null
    }
    if (!claim || claim.status !== "done" || !claim.orderRef) return notFound()

    let live: BillOrderV2Row | null = null
    try {
      live = await deps.getOrderByCode(ctx.userId, claim.orderRef)
    } catch {
      live = null
    }
    if (live) return ok(200, { order: mapBillOrder(live, ref.reference) })
    if (!isObject(claim.response)) return notFound()
    return ok(200, { order: publicFromStored(claim.response, ref.reference) })
  }
}
