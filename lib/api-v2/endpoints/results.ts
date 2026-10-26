/**
 * Developer API v2 results checker endpoints (standard key): board types,
 * purchase, order lookup, order list. MONEY + PIN PATH (tier 1): this moves
 * wallet money through the shared engine purchaseResultsCheckerVouchers
 * (lib/results-checker-service.ts) and hands out voucher PINs.
 *
 * Every decision lives here, over injected ResultsDeps, so tests need no
 * network. Routes only wire real deps (results-deps.ts) and withV2.
 *
 * The engine takes no client reference, so v2 claims the client reference in
 * api_v2_idempotency (UNIQUE on user, kind, reference) BEFORE the engine is
 * called. Two requests with one reference can never both reach the engine.
 *
 * Live purchase order (each step short-circuits):
 *   parse body (max quantity read first; failure => 503) -> claim
 *     replay      => 200 { order, vouchers, replayed: true } (vouchers re-read
 *                    owner-scoped; no gate, no engine, no delivery)
 *     conflict    => 409 REFERENCE_REUSED
 *     in_progress => 409 REQUEST_IN_PROGRESS
 *     unknown     => 409 OUTCOME_UNKNOWN
 *     error       => 503 (fail closed, retryable)
 *   -> board enabled (else release, 503) -> stock pre-check (else release, 409)
 *   -> account phone gate (block or throw: release, 403)
 *   -> engine
 *     success                  => complete the claim, best-effort delivery to
 *                                 the RECIPIENT only, 201 { order, vouchers, new_balance }
 *     INSUFFICIENT_BALANCE     => release, 402
 *     anything else / throws   => mark the claim unknown + urgent alert, never release
 *
 * PIN hygiene: PINs and serials exist ONLY in the response body. They are never
 * stored in the claim response, logged, alerted or put in an error message.
 * Messages are fixed strings; engine text, recipients and bodies are never echoed.
 */
import type { V2Context, V2HandlerResult } from "../handler"
import type { V2ErrorStatus } from "../envelope"
import type { ClaimOutcome } from "../idempotency"
import { mapClaimState, mapCommissionStatus } from "../commission"
import {
  classifyResultsError,
  mapResultsOrder,
  mapVoucher,
  parseResultsBody,
  resultsErrorResponse,
  resultsHash,
  type ExamBoard,
  type PublicResultsOrder,
  type PublicVoucher,
  type ResultsInput,
} from "../standard-orders"
import { parseReference } from "../data-orders"
import { MSG_PHONE_GATE, MSG_REFERENCE_REUSED, MSG_UNAVAILABLE } from "./data"
import { createHash } from "crypto"

// ---------------------------------------------------------------- deps

export const RESULTS_BOARDS: readonly ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]

/** Exactly what v2 passes to purchaseResultsCheckerVouchers. Never a shopId or applyBulk. */
export interface ResultsEngineParams {
  userId: string
  examBoard: ExamBoard
  quantity: number
}

/** The subset of RCPurchaseResult v2 reads. */
export interface ResultsEngineResult {
  order: Record<string, any>
  vouchers: { id?: string; pin: string; serial_number: string | null }[]
  newBalance: number
}

/** The allow-listed results_checker_orders columns v2 selects (filtered by user_id). */
export interface ResultsOrderRow {
  reference_code: string
  exam_board: string
  quantity: number | string
  unit_price: number | string | null
  total_paid: number | string | null
  status: string
  created_at: string
}

/** What lib/sandbox.ts getSandboxOrder / listSandboxOrders return. */
export interface ResultsSandboxOrder {
  reference: string
  action: string
  response: unknown
  price: number | string
  created_at: string
  status: string
}

export interface ResultsSandboxPlaceParams {
  userId: string
  apiV2KeyId: string
  action: "results_checker"
  reference: string
  request: Record<string, unknown>
  price: number
  orderFields: Record<string, unknown>
  instant: true
}

export type ResultsSandboxPlaceResult =
  | { success: true; order: Record<string, unknown>; newBalance: number }
  | { success: false; error: string; status: number }

export interface ResultsDeps {
  claim(p: { userId: string; apiV2KeyId: string; kind: "results"; reference: string; requestHash: string }): Promise<ClaimOutcome>
  /** Each finalisation is owner-guarded: callers always pass ctx.userId. */
  complete(claimId: string, orderRef: string, response: unknown, userId: string): Promise<boolean>
  release(claimId: string, userId: string): Promise<boolean>
  markUnknown(claimId: string, userId: string, orderRef?: string): Promise<boolean>
  /** URGENT admin alert. PII-free, PIN-free: user id and client reference only. */
  alert(message: string): Promise<void>
  getClaim(
    userId: string,
    reference: string
  ): Promise<{ orderRef: string | null; status: string; response: unknown; createdAt?: string | null } | null>
  /** null on a read error (the list answers 503, never an empty 200). */
  listClaims(userId: string, limit: number): Promise<{ reference: string; orderRef: string | null; status: string }[] | null>
  engine(p: ResultsEngineParams): Promise<ResultsEngineResult>
  /** The admin max quantity per purchase. Throws on a read failure. */
  getMaxQuantity(): Promise<number>
  boardEnabled(board: ExamBoard): Promise<boolean>
  /** Stock COUNT only; never PIN data. */
  available(board: ExamBoard): Promise<number>
  /** Read-only engine pricing for the board. */
  price(board: ExamBoard, quantity: number): Promise<{ unitPrice: number; totalPaid: number }>
  /**
   * Owner-scoped: resolves the vouchers THROUGH the user's own completed order
   * (never by board). null when the order is missing, not the user's, not
   * completed, or any read fails.
   */
  readVouchers(userId: string, orderRef: string): Promise<{ pin: string; serial_number: string | null }[] | null>
  /** Owner-scoped; null when missing or unreadable. */
  getOrderByCode(userId: string, code: string): Promise<ResultsOrderRow | null>
  /** Owner-scoped, one query; null on a read error. */
  getOrdersByCodes(userId: string, codes: string[]): Promise<ResultsOrderRow[] | null>
  /** Best-effort delivery to the RECIPIENT contact supplied on the request. */
  deliver(
    order: Record<string, any>,
    vouchers: ResultsEngineResult["vouchers"],
    phone: string | null,
    email: string | null
  ): Promise<void>
  /** Account phone gate; only `true` passes, a throw is a block. */
  phoneGate(userId: string): Promise<boolean>
  sandbox: {
    getOrder(userId: string, reference: string): Promise<ResultsSandboxOrder | null>
    /** null on a read error. */
    listOrders(userId: string, action: "results_checker", limit: number): Promise<ResultsSandboxOrder[] | null>
    place(p: ResultsSandboxPlaceParams): Promise<ResultsSandboxPlaceResult>
  }
  now(): number
}

// ---------------------------------------------------------------- messages

export const RESULTS_LIST_LIMIT = 30
export const SANDBOX_MAX_QUANTITY = 15

export const MSG_RESULTS_NOT_FOUND = "Order not found"
const PENDING_TAIL =
  "Do not place this order again under a new reference. Poll GET /resultschecker/orders/{reference}, whose claim.state reports it, or contact support quoting the reference"
export const MSG_RESULTS_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${PENDING_TAIL}`
export const MSG_RESULTS_PRIOR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${PENDING_TAIL}`
export const MSG_RESULTS_OUTCOME_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this purchase is not confirmed yet. ${PENDING_TAIL}`
export const MSG_RESULTS_CLAIM_UNAVAILABLE =
  "UNAVAILABLE: could not reserve this reference; nothing was charged. Retry with the same reference"
export const MSG_VOUCHERS_UNAVAILABLE =
  "UNAVAILABLE: the vouchers could not be read right now. Retry the same request with the same reference; do not place a new order"
export const MSG_RESULTS_SANDBOX_UNAVAILABLE = "Sandbox is temporarily unavailable"
export const MSG_RESULTS_SANDBOX_FAILED = "Order could not be placed"

const LOG_COMPLETE_FAILED = "[API v2] results: claim not finalised after a successful purchase (reads as unknown later)"
const LOG_RELEASE_FAILED = "[API v2] results: claim release failed (reference stays blocked)"
const LOG_UNKNOWN_FAILED = "[API v2] results: could not mark claim unknown (reads as unknown once stale)"
const LOG_AMBIGUOUS = "[API v2] results: ambiguous engine outcome; claim marked unknown"
const LOG_DELIVERY_FAILED = "[API v2] results: recipient delivery failed (purchase unaffected)"

const ERROR_STATUSES = new Set<number>([400, 401, 402, 403, 404, 409, 429, 500, 502, 503])

function fail(status: V2ErrorStatus, message: string): V2HandlerResult {
  return { status, error: { status, message } }
}

const ok = (status: number, data: unknown): V2HandlerResult => ({ status, data })
const notFound = () => fail(404, MSG_RESULTS_NOT_FOUND)

// ---------------------------------------------------------------- helpers

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const money = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** A stored public order re-read through the allow-list (extra keys never leave). */
function publicFromStored(s: unknown, reference: string): PublicResultsOrder {
  const r = isObject(s) ? s : {}
  return mapResultsOrder(r, reference)
}

function mapVouchers(list: { pin: string; serial_number: string | null }[]): PublicVoucher[] {
  return list.map(mapVoucher)
}

async function gateOk(deps: ResultsDeps, userId: string): Promise<boolean> {
  try {
    return (await deps.phoneGate(userId)) === true
  } catch {
    return false
  }
}

async function safeRelease(deps: ResultsDeps, claimId: string, userId: string): Promise<void> {
  let released = false
  try {
    released = await deps.release(claimId, userId)
  } catch {
    released = false
  }
  if (!released) console.error(LOG_RELEASE_FAILED)
}

async function safeMarkUnknown(deps: ResultsDeps, claimId: string, userId: string, orderRef?: string): Promise<void> {
  let marked = false
  try {
    marked = orderRef ? await deps.markUnknown(claimId, userId, orderRef) : await deps.markUnknown(claimId, userId)
  } catch {
    marked = false
  }
  if (!marked) console.error(LOG_UNKNOWN_FAILED)
}

/** Best-effort URGENT admin alert; never throws and never changes the response. */
async function safeAlert(deps: ResultsDeps, message: string): Promise<void> {
  try {
    await deps.alert(message)
  } catch {
    // alerting must never break the flow
  }
}

/** Ambiguous outcome: the claim becomes unknown and admins get an urgent, PII/PIN-free alert. */
async function markAmbiguous(deps: ResultsDeps, claimId: string, ctx: V2Context, reference: string, orderRef?: string): Promise<void> {
  await safeMarkUnknown(deps, claimId, ctx.userId, orderRef)
  await safeAlert(
    deps,
    `Results API outcome uncertain: claim ${reference}, user ${ctx.userId} (results). Check the wallet and the results order before anything is resent.`
  )
}

function engineCode(e: unknown): unknown {
  return isObject(e) || e instanceof Error ? (e as { code?: unknown }).code : undefined
}

/** Engine error -> {status, message}; numbers travel in the message text, engine text never does. */
function errorResult(e: unknown): V2HandlerResult {
  const r = resultsErrorResponse(e)
  const status = (ERROR_STATUSES.has(r.status) ? r.status : 500) as V2ErrorStatus
  if (r.code === "INSUFFICIENT_BALANCE") {
    return fail(
      status,
      r.required !== undefined
        ? `INSUFFICIENT_BALANCE: wallet balance is too low; required ${r.required.toFixed(2)}`
        : "INSUFFICIENT_BALANCE: wallet balance is too low"
    )
  }
  return fail(status, `${r.code}: ${r.message}`)
}

// ---------------------------------------------------------------- types

export function typesHandler(deps: ResultsDeps) {
  return async (_ctx: V2Context): Promise<V2HandlerResult> => {
    const rows = await Promise.all(
      RESULTS_BOARDS.map(async (board) => {
        try {
          const [enabled, available, p] = await Promise.all([deps.boardEnabled(board), deps.available(board), deps.price(board, 1)])
          const unit = Number(p?.unitPrice)
          if (typeof enabled !== "boolean" || !Number.isFinite(unit) || !Number.isFinite(Number(available))) throw new Error("bad")
          return {
            ok: true as const,
            value: { exam_board: board, price: money(unit), available: Math.max(0, Math.floor(Number(available))), enabled },
          }
        } catch {
          return { ok: false as const, value: { exam_board: board, price: null, available: 0, enabled: false } }
        }
      })
    )
    if (rows.every((r) => !r.ok)) return fail(503, MSG_UNAVAILABLE)
    return ok(200, { types: rows.map((r) => r.value) })
  }
}

// ---------------------------------------------------------------- purchase

export function purchaseResultsHandler(deps: ResultsDeps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const sandbox = ctx.environment === "test"
    let max: number
    try {
      max = Number(await deps.getMaxQuantity())
      if (!Number.isSafeInteger(max) || max < 1) throw new Error("bad max")
    } catch {
      if (!sandbox) return fail(503, MSG_UNAVAILABLE)
      max = SANDBOX_MAX_QUANTITY
    }
    const parsed = parseResultsBody(body, max)
    if (!parsed.ok) return fail(400, parsed.error)
    const input = parsed.value
    if (!sandbox) return livePurchase(deps, input, ctx)
    try {
      return await sandboxPurchase(deps, input, ctx)
    } catch {
      return fail(500, MSG_RESULTS_SANDBOX_UNAVAILABLE)
    }
  }
}

async function livePurchase(deps: ResultsDeps, input: ResultsInput, ctx: V2Context): Promise<V2HandlerResult> {
  // 1. Claim the reference BEFORE anything that can charge. Decides replays too.
  let outcome: ClaimOutcome
  try {
    outcome = await deps.claim({
      userId: ctx.userId,
      apiV2KeyId: ctx.keyId,
      kind: "results",
      reference: input.reference,
      requestHash: resultsHash(input),
    })
  } catch {
    outcome = { kind: "error" }
  }
  switch (outcome.kind) {
    case "replay":
      return replayPurchase(deps, ctx, outcome.orderRef, outcome.response, input.reference)
    case "conflict":
      return fail(409, MSG_REFERENCE_REUSED)
    case "in_progress":
      return fail(409, MSG_RESULTS_IN_PROGRESS)
    case "unknown":
      return fail(409, MSG_RESULTS_PRIOR_UNKNOWN)
    case "claimed":
      break
    default:
      return fail(503, MSG_RESULTS_CLAIM_UNAVAILABLE)
  }
  const claimId = outcome.claimId
  const unavailable = async (message: string, status: V2ErrorStatus = 503) => {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(status, message)
  }

  // 2. Board switch (fail closed). Nothing was charged: free the reference.
  let enabled = false
  try {
    enabled = (await deps.boardEnabled(input.board)) === true
  } catch {
    return unavailable(MSG_UNAVAILABLE)
  }
  if (!enabled) return unavailable(`${input.board} vouchers are currently unavailable`)

  // 3. Stock pre-check (the engine would debit then refund; avoid the round trip).
  let stock: number
  try {
    stock = Number(await deps.available(input.board))
  } catch {
    return unavailable(MSG_UNAVAILABLE)
  }
  if (!Number.isFinite(stock)) return unavailable(MSG_UNAVAILABLE)
  if (stock < input.quantity) {
    return unavailable(`OUT_OF_STOCK: ${input.board} vouchers are out of stock for this quantity; nothing was charged`, 409)
  }

  // 4. Account phone gate (fail closed).
  if (!(await gateOk(deps, ctx.userId))) return unavailable(MSG_PHONE_GATE, 403)

  // 5. The engine. Only INSUFFICIENT_BALANCE frees the reference.
  let result: ResultsEngineResult
  try {
    result = await deps.engine({ userId: ctx.userId, examBoard: input.board, quantity: input.quantity })
  } catch (e) {
    if (classifyResultsError(engineCode(e)) === "no_charge") {
      await safeRelease(deps, claimId, ctx.userId)
      return errorResult(e)
    }
    await markAmbiguous(deps, claimId, ctx, input.reference)
    console.error(LOG_AMBIGUOUS)
    // INSUFFICIENT_INVENTORY gets its specific wording; everything else the generic unknown message.
    return engineCode(e) === "INSUFFICIENT_INVENTORY" ? errorResult(e) : fail(500, MSG_RESULTS_OUTCOME_UNKNOWN)
  }

  const code = result?.order?.reference_code
  if (typeof code !== "string" || !code || !Array.isArray(result.vouchers)) {
    // The engine returned without a usable order: money may have moved.
    await markAmbiguous(deps, claimId, ctx, input.reference, typeof code === "string" && code ? code : undefined)
    console.error(LOG_AMBIGUOUS)
    return fail(500, MSG_RESULTS_OUTCOME_UNKNOWN)
  }

  // 6. Success. The stored claim response holds the order only: NEVER a PIN.
  const order = mapResultsOrder(result.order, input.reference)
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

  // 7. Best-effort delivery to the RECIPIENT only, and only when one was supplied.
  //    Never to the account profile (v1 did; v2 does not). Never changes the response.
  if (input.recipientPhone || input.recipientEmail) {
    try {
      await deps.deliver(result.order, result.vouchers, input.recipientPhone, input.recipientEmail)
    } catch {
      console.warn(LOG_DELIVERY_FAILED)
    }
  }

  const nb = Number(result.newBalance)
  return ok(201, {
    order,
    vouchers: mapVouchers(result.vouchers),
    new_balance: Number.isFinite(nb) ? money(nb) : null,
  })
}

/**
 * Replay of a finished purchase: status refreshed from the owner-scoped live row and the
 * vouchers re-read through that order. No gate, no engine, NO delivery. Fails closed (503)
 * when the order cannot be confirmed, so a PIN is never served from an unverified order.
 */
async function replayPurchase(
  deps: ResultsDeps,
  ctx: V2Context,
  orderRef: string,
  stored: unknown,
  reference: string
): Promise<V2HandlerResult> {
  let live: ResultsOrderRow | null = null
  try {
    live = await deps.getOrderByCode(ctx.userId, orderRef)
  } catch {
    live = null
  }
  if (!live) return fail(503, MSG_VOUCHERS_UNAVAILABLE)
  const order = { ...publicFromStored(stored, reference), status: mapCommissionStatus(live.status) }
  if (order.status !== "completed") return ok(200, { order, vouchers: [], replayed: true })
  const vouchers = await safeReadVouchers(deps, ctx.userId, orderRef)
  if (!vouchers) return fail(503, MSG_VOUCHERS_UNAVAILABLE)
  return ok(200, { order, vouchers, replayed: true })
}

/** Non-empty owner-scoped vouchers through the order, or null. */
async function safeReadVouchers(deps: ResultsDeps, userId: string, orderRef: string): Promise<PublicVoucher[] | null> {
  try {
    const list = await deps.readVouchers(userId, orderRef)
    if (!Array.isArray(list) || list.length === 0) return null
    return mapVouchers(list)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- sandbox

function sandboxResponse(prior: ResultsSandboxOrder): Record<string, unknown> {
  return isObject(prior.response) ? prior.response : {}
}

function sandboxMatches(input: ResultsInput, prior: ResultsSandboxOrder): boolean {
  if (prior.action !== "results_checker") return false
  const r = sandboxResponse(prior)
  return r.exam_board === input.board && Number(r.quantity) === input.quantity
}

/** Fake vouchers derived only from the stored order, so replay and lookup agree. */
export function sandboxVouchers(reference: string, board: string, quantity: number): PublicVoucher[] {
  const n = Number.isSafeInteger(quantity) && quantity > 0 ? Math.min(quantity, 50) : 0
  return Array.from({ length: n }, (_, i) => {
    const h = createHash("sha256").update(`${reference}:${i}`).digest()
    const digits = String(h.readUInt32BE(0) % 100_000_000).padStart(8, "0")
    return { pin: `TEST-${digits}`, serial_number: `SANDBOX-${board}-${String(i + 1).padStart(4, "0")}` }
  })
}

function mapSandboxOrder(prior: ResultsSandboxOrder): PublicResultsOrder {
  const r = sandboxResponse(prior)
  return mapResultsOrder(
    { exam_board: r.exam_board, quantity: r.quantity, unit_price: r.unit_price, total_paid: r.total_paid, status: prior.status, created_at: prior.created_at },
    prior.reference
  )
}

function sandboxVouchersOf(prior: ResultsSandboxOrder): PublicVoucher[] {
  const o = mapSandboxOrder(prior)
  return sandboxVouchers(prior.reference, o.exam_board, o.quantity)
}

async function sandboxPurchase(deps: ResultsDeps, input: ResultsInput, ctx: V2Context): Promise<V2HandlerResult> {
  const replay = (prior: ResultsSandboxOrder) =>
    ok(200, { order: mapSandboxOrder(prior), vouchers: sandboxVouchersOf(prior), replayed: true, sandbox: true })

  const prior = await deps.sandbox.getOrder(ctx.userId, input.reference)
  if (prior) return sandboxMatches(input, prior) ? replay(prior) : fail(409, MSG_REFERENCE_REUSED)

  // Real, read-only pricing; fake PINs; no claim, engine, inventory, gate or delivery.
  const pricing = await deps.price(input.board, input.quantity)
  const unitPrice = money(pricing?.unitPrice)
  const totalPaid = money(pricing?.totalPaid)
  if (!Number.isFinite(Number(pricing?.totalPaid))) return fail(500, MSG_RESULTS_SANDBOX_FAILED)

  const placed = await deps.sandbox.place({
    userId: ctx.userId,
    apiV2KeyId: ctx.keyId,
    action: "results_checker",
    reference: input.reference,
    request: { exam_board: input.board, quantity: input.quantity, reference: input.reference },
    price: totalPaid,
    orderFields: { exam_board: input.board, quantity: input.quantity, unit_price: unitPrice, total_paid: totalPaid },
    instant: true,
  })
  if (!placed.success) {
    if (placed.status === 402) {
      return fail(402, `INSUFFICIENT_BALANCE: test balance is too low; required ${totalPaid.toFixed(2)}`)
    }
    if (placed.status === 409) {
      const again = await deps.sandbox.getOrder(ctx.userId, input.reference)
      if (again && sandboxMatches(input, again)) return replay(again)
      return fail(409, MSG_REFERENCE_REUSED)
    }
    return fail(500, MSG_RESULTS_SANDBOX_FAILED)
  }
  const o = placed.order
  const order = mapResultsOrder(
    {
      exam_board: input.board,
      quantity: input.quantity,
      unit_price: unitPrice,
      total_paid: totalPaid,
      status: o.status ?? "completed",
      created_at: typeof o.created_at === "string" ? o.created_at : new Date(deps.now()).toISOString(),
    },
    input.reference
  )
  return ok(201, {
    order,
    vouchers: sandboxVouchers(input.reference, input.board, input.quantity),
    new_balance: placed.newBalance,
    sandbox: true,
  })
}

// ---------------------------------------------------------------- lookup

export function resultsOrderHandler(deps: ResultsDeps) {
  return async (reference: string, ctx: V2Context): Promise<V2HandlerResult> => {
    // Malformed, missing, foreign: all get this one body.
    const ref = parseReference(reference)
    if (!ref.ok) return notFound()

    if (ctx.environment === "test") {
      let prior: ResultsSandboxOrder | null
      try {
        prior = await deps.sandbox.getOrder(ctx.userId, ref.reference)
      } catch {
        return fail(500, MSG_RESULTS_SANDBOX_UNAVAILABLE)
      }
      if (!prior || prior.action !== "results_checker") return notFound()
      return ok(200, { order: mapSandboxOrder(prior), vouchers: sandboxVouchersOf(prior), claim: null, sandbox: true })
    }

    let claim: Awaited<ReturnType<ResultsDeps["getClaim"]>>
    try {
      claim = await deps.getClaim(ctx.userId, ref.reference)
    } catch {
      claim = null
    }
    if (!claim) return notFound()
    // The caller's own claim that is still running or ambiguous: say so (never a 404).
    const pending = mapClaimState(claim, ref.reference, deps.now())
    if (pending) return ok(200, { order: null, claim: pending })
    if (claim.status !== "done" || !claim.orderRef) return notFound()

    // Fail closed: no PIN is served from an order that cannot be confirmed as the owner's.
    let live: ResultsOrderRow | null = null
    try {
      live = await deps.getOrderByCode(ctx.userId, claim.orderRef)
    } catch {
      live = null
    }
    if (!live) return fail(503, MSG_VOUCHERS_UNAVAILABLE)
    const base = isObject(claim.response) ? publicFromStored(claim.response, ref.reference) : mapResultsOrder(live, ref.reference)
    const order = { ...base, status: mapCommissionStatus(live.status) }
    if (order.status !== "completed") return ok(200, { order, vouchers: [], claim: null })
    const vouchers = await safeReadVouchers(deps, ctx.userId, claim.orderRef)
    if (!vouchers) return fail(503, MSG_VOUCHERS_UNAVAILABLE)
    return ok(200, { order, vouchers, claim: null })
  }
}

// ---------------------------------------------------------------- list

export function resultsListHandler(deps: ResultsDeps) {
  return async (ctx: V2Context): Promise<V2HandlerResult> => {
    if (ctx.environment === "test") {
      let rows: ResultsSandboxOrder[] | null
      try {
        rows = await deps.sandbox.listOrders(ctx.userId, "results_checker", RESULTS_LIST_LIMIT)
      } catch {
        return fail(500, MSG_RESULTS_SANDBOX_UNAVAILABLE)
      }
      if (!rows) return fail(503, MSG_UNAVAILABLE)
      const orders = rows
        .filter((r) => r.action === "results_checker")
        .slice(0, RESULTS_LIST_LIMIT)
        .map(mapSandboxOrder)
      return ok(200, { orders, sandbox: true })
    }

    let claims: Awaited<ReturnType<ResultsDeps["listClaims"]>>
    try {
      claims = await deps.listClaims(ctx.userId, RESULTS_LIST_LIMIT)
    } catch {
      return fail(503, MSG_UNAVAILABLE)
    }
    if (!Array.isArray(claims)) return fail(503, MSG_UNAVAILABLE)
    const done = claims
      .slice(0, RESULTS_LIST_LIMIT)
      .filter((c): c is { reference: string; orderRef: string; status: string } => c.status === "done" && !!c.orderRef)
    if (done.length === 0) return ok(200, { orders: [] })

    let rows: ResultsOrderRow[] | null
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
    // Vouchers are never part of the list.
    const orders = done.flatMap((c) => {
      const row = byCode.get(c.orderRef)
      return row ? [mapResultsOrder(row, c.reference)] : []
    })
    return ok(200, { orders })
  }
}
