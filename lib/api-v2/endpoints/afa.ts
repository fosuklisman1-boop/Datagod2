/**
 * Developer API v2 AFA registration endpoints (standard key): register, order
 * lookup, order list. MONEY PATH (tier 1): moves wallet money through the shared
 * engine submitAfaOrder (lib/afa-fulfillment.ts).
 *
 * Every decision lives here, over injected AfaDeps, so tests need no network.
 *
 * The engine takes no client reference, so v2 claims the client reference in
 * api_v2_idempotency BEFORE the engine is called. Because the engine has no
 * duplicate protection of its own, v2 adds a duplicate guard (same phone or same
 * Ghana Card, same user, non-failed, last 10 minutes) after the phone gate.
 *
 * Live register order (each step short-circuits):
 *   parse body (no I/O) -> claim
 *     replay => 200 { order, replayed: true } | conflict 409 | in_progress 409 | unknown 409 | error 503
 *   -> phone gate (release, 403) -> duplicate guard (release, 409; read error release, 503)
 *   -> engine: success => complete the claim, 201 { order }
 *              no-charge code => release, mapped 400/402/503
 *              anything else / throws => mark unknown + urgent alert, 500
 *
 * PRIVACY: the Ghana Card number appears in no response, log, alert, error message
 * or claim; it reaches the engine and the request hash (sha256) only.
 */
import type { V2Context, V2HandlerResult } from "../handler"
import type { V2ErrorStatus } from "../envelope"
import type { ClaimOutcome } from "../idempotency"
import { mapClaimState } from "../commission"
import {
  afaErrorResponse,
  afaHash,
  classifyAfaError,
  mapAfaOrder,
  parseAfaBody,
  type AfaInput,
  type PublicAfaOrder,
} from "../standard-orders"
import { parseReference } from "../data-orders"
import { MSG_PHONE_GATE, MSG_REFERENCE_REUSED, MSG_UNAVAILABLE } from "./data"

// ---------------------------------------------------------------- deps

/** Exactly what v2 passes to submitAfaOrder. Phone is the LOCAL form. */
export interface AfaEngineParams {
  userId: string
  fullName: string
  phoneNumber: string
  ghCardNumber: string
  location: string
  region: string
  occupation?: string
}

/** The subset of the afa_orders row v2 reads from the engine result (the row also holds the card: never forwarded). */
export interface AfaEngineResult {
  order: Record<string, any>
}

/** The allow-listed afa_orders columns v2 selects (filtered by user_id). */
export interface AfaOrderRow {
  order_code: string
  full_name: string
  phone_number: string
  region: string
  amount: number | string
  status: string
  fulfillment_status: string | null
  created_at: string
}

export interface AfaSandboxOrder {
  reference: string
  action: string
  response: unknown
  price: number | string
  created_at: string
  status: string
}

export interface AfaSandboxPlaceParams {
  userId: string
  apiV2KeyId: string
  action: "afa"
  reference: string
  request: Record<string, unknown>
  price: number
  orderFields: Record<string, unknown>
}

export type AfaSandboxPlaceResult =
  | { success: true; order: Record<string, unknown>; newBalance: number }
  | { success: false; error: string; status: number }

export interface AfaDeps {
  claim(p: { userId: string; apiV2KeyId: string; kind: "afa"; reference: string; requestHash: string }): Promise<ClaimOutcome>
  complete(claimId: string, orderRef: string, response: unknown, userId: string): Promise<boolean>
  release(claimId: string, userId: string): Promise<boolean>
  markUnknown(claimId: string, userId: string, orderRef?: string): Promise<boolean>
  /** URGENT admin alert. PII-free: user id and client reference only. */
  alert(message: string): Promise<void>
  getClaim(
    userId: string,
    reference: string
  ): Promise<{ orderRef: string | null; status: string; response: unknown; createdAt?: string | null } | null>
  listClaims(userId: string, limit: number): Promise<{ reference: string; orderRef: string | null; status: string }[] | null>
  engine(p: AfaEngineParams): Promise<AfaEngineResult>
  /**
   * True when an afa_orders row of THIS user, status not "failed", created at or after
   * `sinceIso`, has the same phone (local or msisdn form) OR the same Ghana Card.
   * Throws on a read error (v2 fails closed).
   */
  findRecentDuplicate(userId: string, phoneLocal: string, cardCanonical: string, sinceIso: string): Promise<boolean>
  /** Owner-scoped, newest match for (user, order_code); null when missing or unreadable. */
  getOrderByCode(userId: string, code: string): Promise<AfaOrderRow | null>
  /** Owner-scoped, one query, newest row per code; null on a read error. */
  getOrdersByCodes(userId: string, codes: string[]): Promise<AfaOrderRow[] | null>
  /** Account phone gate; only `true` passes, a throw is a block. */
  phoneGate(userId: string): Promise<boolean>
  /** Active AFA registration price (as v1 reads it). Throws or non-positive when unavailable. */
  afaPrice(): Promise<number>
  sandbox: {
    getOrder(userId: string, reference: string): Promise<AfaSandboxOrder | null>
    listOrders(userId: string, action: "afa", limit: number): Promise<AfaSandboxOrder[] | null>
    place(p: AfaSandboxPlaceParams): Promise<AfaSandboxPlaceResult>
  }
  now(): number
}

// ---------------------------------------------------------------- messages

export const AFA_LIST_LIMIT = 30
export const AFA_DUPLICATE_WINDOW_MS = 10 * 60 * 1000

export const MSG_AFA_NOT_FOUND = "Order not found"
const PENDING_TAIL =
  "Do not place this registration again under a new reference. Poll GET /afa/orders/{reference}, whose claim.state reports it, or contact support quoting the reference"
export const MSG_AFA_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${PENDING_TAIL}`
export const MSG_AFA_PRIOR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${PENDING_TAIL}`
export const MSG_AFA_OUTCOME_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this registration is not confirmed yet. ${PENDING_TAIL}`
export const MSG_AFA_CLAIM_UNAVAILABLE =
  "UNAVAILABLE: could not reserve this reference; nothing was charged. Retry with the same reference"
export const MSG_AFA_DUPLICATE =
  "DUPLICATE_REGISTRATION: a registration for this customer was just submitted. Look it up under its original reference; do not resubmit under a new reference"
export const MSG_AFA_SANDBOX_UNAVAILABLE = "Sandbox is temporarily unavailable"
export const MSG_AFA_SANDBOX_FAILED = "Order could not be placed"

const LOG_COMPLETE_FAILED = "[API v2] afa: claim not finalised after a successful registration (reads as unknown later)"
const LOG_RELEASE_FAILED = "[API v2] afa: claim release failed (reference stays blocked)"
const LOG_UNKNOWN_FAILED = "[API v2] afa: could not mark claim unknown (reads as unknown once stale)"
const LOG_AMBIGUOUS = "[API v2] afa: ambiguous engine outcome; claim marked unknown"

const ERROR_STATUSES = new Set<number>([400, 401, 402, 403, 404, 409, 429, 500, 502, 503])

function fail(status: V2ErrorStatus, message: string): V2HandlerResult {
  return { status, error: { status, message } }
}
const ok = (status: number, data: unknown): V2HandlerResult => ({ status, data })
const notFound = () => fail(404, MSG_AFA_NOT_FOUND)

// ---------------------------------------------------------------- helpers

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const money = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** A stored public order re-read through the allow-list. */
function publicFromStored(s: unknown, reference: string): PublicAfaOrder {
  const r = isObject(s) ? s : {}
  return mapAfaOrder(
    {
      full_name: r.full_name,
      phone_number: r.phone,
      region: r.region,
      amount: r.amount,
      status: r.status,
      fulfillment_status: r.fulfillment,
      created_at: r.created_at,
    },
    reference
  )
}

async function gateOk(deps: AfaDeps, userId: string): Promise<boolean> {
  try {
    return (await deps.phoneGate(userId)) === true
  } catch {
    return false
  }
}

async function safeRelease(deps: AfaDeps, claimId: string, userId: string): Promise<void> {
  let released = false
  try {
    released = await deps.release(claimId, userId)
  } catch {
    released = false
  }
  if (!released) console.error(LOG_RELEASE_FAILED)
}

async function safeMarkUnknown(deps: AfaDeps, claimId: string, userId: string, orderRef?: string): Promise<void> {
  let marked = false
  try {
    marked = orderRef ? await deps.markUnknown(claimId, userId, orderRef) : await deps.markUnknown(claimId, userId)
  } catch {
    marked = false
  }
  if (!marked) console.error(LOG_UNKNOWN_FAILED)
}

async function safeAlert(deps: AfaDeps, message: string): Promise<void> {
  try {
    await deps.alert(message)
  } catch {
    // alerting must never break the flow
  }
}

async function markAmbiguous(deps: AfaDeps, claimId: string, ctx: V2Context, reference: string, orderRef?: string): Promise<void> {
  await safeMarkUnknown(deps, claimId, ctx.userId, orderRef)
  await safeAlert(
    deps,
    `AFA API outcome uncertain: claim ${reference}, user ${ctx.userId} (afa). Check the wallet and the AFA order before anything is resent.`
  )
}

function engineCode(e: unknown): unknown {
  return isObject(e) || e instanceof Error ? (e as { code?: unknown }).code : undefined
}

function errorResult(e: unknown): V2HandlerResult {
  const r = afaErrorResponse(e)
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

function engineParams(ctx: V2Context, input: AfaInput): AfaEngineParams {
  return {
    userId: ctx.userId,
    fullName: input.fullName,
    phoneNumber: input.phone.local,
    ghCardNumber: input.cardCanonical,
    location: input.location,
    region: input.region,
    ...(input.occupation !== null ? { occupation: input.occupation } : {}),
  }
}

// ---------------------------------------------------------------- register

export function registerAfaHandler(deps: AfaDeps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const parsed = parseAfaBody(body)
    if (!parsed.ok) return fail(400, parsed.error)
    const input = parsed.value
    if (ctx.environment !== "test") return liveRegister(deps, input, ctx)
    try {
      return await sandboxRegister(deps, input, ctx)
    } catch {
      return fail(500, MSG_AFA_SANDBOX_UNAVAILABLE)
    }
  }
}

async function liveRegister(deps: AfaDeps, input: AfaInput, ctx: V2Context): Promise<V2HandlerResult> {
  let outcome: ClaimOutcome
  try {
    outcome = await deps.claim({
      userId: ctx.userId,
      apiV2KeyId: ctx.keyId,
      kind: "afa",
      reference: input.reference,
      requestHash: afaHash(input),
    })
  } catch {
    outcome = { kind: "error" }
  }
  switch (outcome.kind) {
    case "replay": {
      let live: AfaOrderRow | null = null
      try {
        live = await deps.getOrderByCode(ctx.userId, outcome.orderRef)
      } catch {
        live = null
      }
      const order = live ? mapAfaOrder(live, input.reference) : publicFromStored(outcome.response, input.reference)
      return ok(200, { order, replayed: true })
    }
    case "conflict":
      return fail(409, MSG_REFERENCE_REUSED)
    case "in_progress":
      return fail(409, MSG_AFA_IN_PROGRESS)
    case "unknown":
      return fail(409, MSG_AFA_PRIOR_UNKNOWN)
    case "claimed":
      break
    default:
      return fail(503, MSG_AFA_CLAIM_UNAVAILABLE)
  }
  const claimId = outcome.claimId

  // Phone gate (fail closed).
  if (!(await gateOk(deps, ctx.userId))) {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(403, MSG_PHONE_GATE)
  }

  // v2-only duplicate guard. A read error fails closed.
  const since = new Date(deps.now() - AFA_DUPLICATE_WINDOW_MS).toISOString()
  let duplicate: boolean
  try {
    duplicate = await deps.findRecentDuplicate(ctx.userId, input.phone.local, input.cardCanonical, since)
  } catch {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(503, MSG_UNAVAILABLE)
  }
  if (duplicate !== false) {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(409, MSG_AFA_DUPLICATE)
  }

  // Engine. Only classified no-charge codes free the reference.
  let result: AfaEngineResult
  try {
    result = await deps.engine(engineParams(ctx, input))
  } catch (e) {
    if (classifyAfaError(engineCode(e)) === "no_charge") {
      await safeRelease(deps, claimId, ctx.userId)
      return errorResult(e)
    }
    await markAmbiguous(deps, claimId, ctx, input.reference)
    console.error(LOG_AMBIGUOUS)
    return fail(500, MSG_AFA_OUTCOME_UNKNOWN)
  }

  const code = result?.order?.order_code
  if (typeof code !== "string" || !code) {
    await markAmbiguous(deps, claimId, ctx, input.reference)
    console.error(LOG_AMBIGUOUS)
    return fail(500, MSG_AFA_OUTCOME_UNKNOWN)
  }

  // Success. Complete the row with what the engine returned; read back only if it lacks fields.
  let row: Record<string, any> = result.order
  if (typeof row.created_at !== "string" || row.fulfillment_status === undefined) {
    let live: AfaOrderRow | null = null
    try {
      live = await deps.getOrderByCode(ctx.userId, code)
    } catch {
      live = null
    }
    row = live ? { ...row, ...live } : { ...row, created_at: new Date(deps.now()).toISOString() }
  }
  const order = mapAfaOrder(row, input.reference)

  let completed = false
  try {
    completed = await deps.complete(claimId, code, order, ctx.userId)
  } catch {
    completed = false
  }
  if (!completed) {
    console.error(LOG_COMPLETE_FAILED)
    await markAmbiguous(deps, claimId, ctx, input.reference, code)
  }
  return ok(201, { order })
}

// ---------------------------------------------------------------- sandbox

function sandboxResponse(prior: AfaSandboxOrder): Record<string, unknown> {
  return isObject(prior.response) ? prior.response : {}
}

function sandboxMatches(input: AfaInput, prior: AfaSandboxOrder): boolean {
  if (prior.action !== "afa") return false
  return sandboxResponse(prior).request_hash === afaHash(input)
}

function mapSandboxOrder(prior: AfaSandboxOrder): PublicAfaOrder {
  const r = sandboxResponse(prior)
  return mapAfaOrder(
    {
      full_name: r.full_name,
      phone_number: r.phone,
      region: r.region,
      amount: r.amount,
      status: prior.status,
      fulfillment_status: prior.status === "completed" ? "fulfilled" : "pending",
      created_at: prior.created_at,
    },
    prior.reference
  )
}

async function sandboxRegister(deps: AfaDeps, input: AfaInput, ctx: V2Context): Promise<V2HandlerResult> {
  const replay = (prior: AfaSandboxOrder) => ok(200, { order: mapSandboxOrder(prior), replayed: true, sandbox: true })

  const prior = await deps.sandbox.getOrder(ctx.userId, input.reference)
  if (prior) return sandboxMatches(input, prior) ? replay(prior) : fail(409, MSG_REFERENCE_REUSED)

  let price: number
  try {
    price = Number(await deps.afaPrice())
  } catch {
    return fail(503, MSG_UNAVAILABLE)
  }
  if (!Number.isFinite(price) || price <= 0) return fail(503, MSG_UNAVAILABLE)
  price = money(price)

  const placed = await deps.sandbox.place({
    userId: ctx.userId,
    apiV2KeyId: ctx.keyId,
    action: "afa",
    reference: input.reference,
    // No Ghana Card number anywhere: only the sha256-based request hash.
    request: { full_name: input.fullName, phone: input.phone.local, region: input.region, reference: input.reference },
    price,
    orderFields: {
      full_name: input.fullName,
      phone: input.phone.local,
      region: input.region,
      amount: price,
      request_hash: afaHash(input),
    },
  })
  if (!placed.success) {
    if (placed.status === 402) return fail(402, `INSUFFICIENT_BALANCE: test balance is too low; required ${price.toFixed(2)}`)
    if (placed.status === 409) {
      const again = await deps.sandbox.getOrder(ctx.userId, input.reference)
      if (again && sandboxMatches(input, again)) return replay(again)
      return fail(409, MSG_REFERENCE_REUSED)
    }
    return fail(500, MSG_AFA_SANDBOX_FAILED)
  }
  const o = placed.order
  const order = mapAfaOrder(
    {
      full_name: input.fullName,
      phone_number: input.phone.local,
      region: input.region,
      amount: price,
      status: o.status ?? "pending",
      fulfillment_status: "pending",
      created_at: typeof o.created_at === "string" ? o.created_at : new Date(deps.now()).toISOString(),
    },
    input.reference
  )
  return ok(201, { order, new_balance: placed.newBalance, sandbox: true })
}

// ---------------------------------------------------------------- lookup

export function afaOrderHandler(deps: AfaDeps) {
  return async (reference: string, ctx: V2Context): Promise<V2HandlerResult> => {
    const ref = parseReference(reference)
    if (!ref.ok) return notFound()

    if (ctx.environment === "test") {
      let prior: AfaSandboxOrder | null
      try {
        prior = await deps.sandbox.getOrder(ctx.userId, ref.reference)
      } catch {
        return fail(500, MSG_AFA_SANDBOX_UNAVAILABLE)
      }
      if (!prior || prior.action !== "afa") return notFound()
      return ok(200, { order: mapSandboxOrder(prior), claim: null, sandbox: true })
    }

    let claim: Awaited<ReturnType<AfaDeps["getClaim"]>>
    try {
      claim = await deps.getClaim(ctx.userId, ref.reference)
    } catch {
      claim = null
    }
    if (!claim) return notFound()
    const pending = mapClaimState(claim, ref.reference, deps.now())
    if (pending) return ok(200, { order: null, claim: pending })
    if (claim.status !== "done" || !claim.orderRef) return notFound()

    let live: AfaOrderRow | null = null
    try {
      live = await deps.getOrderByCode(ctx.userId, claim.orderRef)
    } catch {
      live = null
    }
    if (live) return ok(200, { order: mapAfaOrder(live, ref.reference), claim: null })
    if (!isObject(claim.response)) return notFound()
    return ok(200, { order: publicFromStored(claim.response, ref.reference), claim: null })
  }
}

// ---------------------------------------------------------------- list

export function afaListHandler(deps: AfaDeps) {
  return async (ctx: V2Context): Promise<V2HandlerResult> => {
    if (ctx.environment === "test") {
      let rows: AfaSandboxOrder[] | null
      try {
        rows = await deps.sandbox.listOrders(ctx.userId, "afa", AFA_LIST_LIMIT)
      } catch {
        return fail(500, MSG_AFA_SANDBOX_UNAVAILABLE)
      }
      if (!rows) return fail(503, MSG_UNAVAILABLE)
      const orders = rows
        .filter((r) => r.action === "afa")
        .slice(0, AFA_LIST_LIMIT)
        .map(mapSandboxOrder)
      return ok(200, { orders, sandbox: true })
    }

    let claims: Awaited<ReturnType<AfaDeps["listClaims"]>>
    try {
      claims = await deps.listClaims(ctx.userId, AFA_LIST_LIMIT)
    } catch {
      return fail(503, MSG_UNAVAILABLE)
    }
    if (!Array.isArray(claims)) return fail(503, MSG_UNAVAILABLE)
    const done = claims
      .slice(0, AFA_LIST_LIMIT)
      .filter((c): c is { reference: string; orderRef: string; status: string } => c.status === "done" && !!c.orderRef)
    if (done.length === 0) return ok(200, { orders: [] })

    let rows: AfaOrderRow[] | null
    try {
      rows = await deps.getOrdersByCodes(
        ctx.userId,
        done.map((c) => c.orderRef)
      )
    } catch {
      rows = null
    }
    if (!rows) return fail(503, MSG_UNAVAILABLE)
    // The engine's code is not unique: the dep returns newest first, the first row per code wins.
    const byCode = new Map<string, AfaOrderRow>()
    for (const r of rows) if (!byCode.has(r.order_code)) byCode.set(r.order_code, r)
    const orders = done.flatMap((c) => {
      const row = byCode.get(c.orderRef)
      return row ? [mapAfaOrder(row, c.reference)] : []
    })
    return ok(200, { orders })
  }
}
