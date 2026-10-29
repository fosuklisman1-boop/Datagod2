/**
 * Developer API v2 Standard Bundles endpoints (commission key): catalog,
 * purchase, order lookup, order list. MONEY PATH (tier 1): purchase moves
 * wallet money through the shared engine buyBundle (lib/standard-bundles/service.ts).
 *
 * Every decision lives here, over injected BundlesV2Deps, so tests need no
 * network. Routes only wire real deps (bundles-deps.ts) and withV2. Mirrors
 * bills.ts / airtime.ts.
 *
 * The engine has its own idempotency key, but its replay ignores the request body
 * and a failed-unpaid order would pin a key to a 402 forever. So v2 claims the
 * client reference in api_v2_idempotency (UNIQUE on user, kind, reference) BEFORE
 * the engine is called, and hands the engine a key derived from the CLAIM id: one
 * claim reaches the engine at most once, and a released claim's retry gets a fresh key.
 *
 * Live purchase order (each step short-circuits):
 *   parse body (price-like fields and a sandbox token refused; no I/O) -> claim
 *     replay      => 200 { order, replayed: true }   (no gate, no engine)
 *     conflict    => 409 REFERENCE_REUSED
 *     in_progress => 409 REQUEST_IN_PROGRESS
 *     unknown     => 409 OUTCOME_UNKNOWN
 *     error       => 503 (fail closed, retryable)
 *   -> API surface gate (closed or unreadable: release the claim, 403)
 *   -> account phone gate (block or throw: release the claim, 403)
 *   -> buyBundle(channel "api")
 *     ok + paid order        => complete the claim, 201 { order }
 *     no-charge refusal      => release the claim, mapped 400/402/403/409/503
 *     anything else / throws => mark the claim unknown, urgent alert, generic 500
 *
 * Messages are fixed strings with the machine code as a prefix; engine text,
 * recipient numbers, tokens and bodies are never echoed or logged.
 */
import type { V2Context, V2HandlerResult } from "../handler"
import type { V2ErrorStatus } from "../envelope"
import type { ClaimOutcome } from "../idempotency"
import { mapClaimState, mapCommissionStatus } from "../commission"
import { normalizeRecipient, parseReference } from "../data-orders"
import {
  BUNDLE_CATALOG_VALID_SECONDS,
  MSG_BUNDLE_NOT_AVAILABLE,
  MSG_BUNDLE_UNAVAILABLE,
  bundleEngineKey,
  bundleHash,
  bundlePriceChangedMessage,
  classifyBundleRefusal,
  mapBundleCatalog,
  mapBundleOrder,
  parseBundleNetwork,
  parseBundlePurchaseBody,
  type BundleApiNetwork,
  type BundlePurchaseInput,
  type PublicBundleOrder,
} from "../bundles"
import type { BundleNetwork } from "@/lib/standard-bundles/categories"
import type { BuyResult } from "@/lib/standard-bundles/service"
import { findSandboxBundle, sandboxCatalog, sandboxOrderFields, type PricedCategory } from "@/lib/api-v1/bundles"
import { MSG_PHONE_GATE, MSG_REFERENCE_REUSED, MSG_UNAVAILABLE } from "./data"
import { MSG_CLAIM_UNAVAILABLE, MSG_SANDBOX_UNAVAILABLE } from "./airtime"

// ---------------------------------------------------------------- deps

/** Exactly what v2 hands buyBundle (channel is always "api", fixed by the real wiring). */
export interface BundleBuyParams {
  userId: string
  token: string
  /** Local form, 0XXXXXXXXX. */
  phone: string
  /** Derived from the claim id, never from the client. */
  idempotencyKey: string
  expectedPay?: number
}

/** The allow-listed hubtel_data_orders columns v2 selects (filtered by user_id). */
export interface BundleOrderRow {
  reference_code: string
  network: string
  beneficiary_phone: string
  bundle_display: string
  amount: number | string
  paid_amount: number | string | null
  cashback_amount: number | string | null
  status: string
  created_at: string
  /** Read only to resolve an `unknown` claim (paid => the order is shown); never returned. */
  payment_status?: string | null
}

/** What lib/sandbox.ts getSandboxOrder / listSandboxOrders return. */
export interface BundleSandboxOrder {
  reference: string
  action: string
  response: unknown
  price: number | string
  created_at: string
  status: string
}

export interface BundleSandboxPlaceParams {
  userId: string
  apiV2KeyId: string
  action: "standard_bundle"
  reference: string
  request: Record<string, unknown>
  price: number
  orderFields: Record<string, unknown>
}

export type BundleSandboxPlaceResult =
  | { success: true; order: Record<string, unknown>; newBalance: number }
  | { success: false; error: string; status: number }

export type BundleCatalogResult =
  | { kind: "ok"; categories: PricedCategory[] }
  /** The admin API surface switch is off (or unreadable), or the bundles/network switch is off. */
  | { kind: "closed" }
  | { kind: "unavailable" }

export interface BundlesV2Deps {
  claim(p: { userId: string; apiV2KeyId: string; kind: "bundle"; reference: string; requestHash: string }): Promise<ClaimOutcome>
  /** Each finalisation is owner-guarded: callers always pass ctx.userId. */
  complete(claimId: string, orderRef: string, response: unknown, userId: string): Promise<boolean>
  release(claimId: string, userId: string): Promise<boolean>
  /** `orderRef`: the engine's order when it supplied one, kept on the unknown claim. */
  markUnknown(claimId: string, userId: string, orderRef?: string): Promise<boolean>
  /** URGENT admin alert for an ambiguous outcome. PII-free: user id and client reference only. */
  alert(message: string): Promise<void>
  getClaim(
    userId: string,
    reference: string
  ): Promise<{ orderRef: string | null; status: string; response: unknown; createdAt?: string | null } | null>
  /** null on a read error (the list answers 503, never an empty 200). */
  listClaims(userId: string, limit: number): Promise<{ reference: string; orderRef: string | null; status: string }[] | null>
  /** The admin API surface switch; only `true` opens. */
  surfaceOpen(): Promise<boolean>
  /** Account phone gate; only `true` passes, a throw is a block. */
  phoneGate(userId: string): Promise<boolean>
  /** Signed, priced catalogue for the key owner's tier (gates included). */
  loadCatalog(userId: string, network: BundleNetwork): Promise<BundleCatalogResult>
  buy(p: BundleBuyParams): Promise<BuyResult>
  /** Owner-scoped; null when missing or unreadable. */
  getOrderByCode(userId: string, code: string): Promise<BundleOrderRow | null>
  /** Owner-scoped, one query; null on a read error. */
  getOrdersByCodes(userId: string, codes: string[]): Promise<BundleOrderRow[] | null>
  sandbox: {
    getOrder(userId: string, reference: string): Promise<BundleSandboxOrder | null>
    /** null on a read error. */
    listOrders(userId: string, action: "standard_bundle", limit: number): Promise<BundleSandboxOrder[] | null>
    place(p: BundleSandboxPlaceParams): Promise<BundleSandboxPlaceResult>
  }
  now(): number
}

// ---------------------------------------------------------------- messages

export const BUNDLE_LIST_LIMIT = 30

export const MSG_BUNDLE_ORDER_NOT_FOUND = "Order not found"
// The pending-outcome messages never promise the lookup resolves it and never suggest a new
// reference: a client that re-places the order under a new reference can be charged twice.
const PENDING_TAIL =
  "Do not place this order again under a new reference. Poll GET /bundles/orders/{reference}, whose claim.state reports it, or contact support quoting the reference"
export const MSG_BUNDLE_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${PENDING_TAIL}`
export const MSG_BUNDLE_PRIOR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${PENDING_TAIL}`
export const MSG_BUNDLE_OUTCOME_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this purchase is not confirmed yet. ${PENDING_TAIL}`
export const MSG_SANDBOX_TOKEN_ON_LIVE =
  "INVALID_TOKEN: this is a sandbox bundle_token; a live key needs a token from GET /bundles/catalog made with a live key"
export const MSG_TOKEN_ON_TEST_KEY =
  "INVALID_TOKEN: a test key needs a sandbox bundle_token from GET /bundles/catalog made with a test key"
export const MSG_BUNDLE_CATALOG_UNAVAILABLE = "UNAVAILABLE: the bundle catalog is temporarily unavailable"
export const MSG_SANDBOX_FAILED = "Order could not be placed"

// Fixed, PII-free log lines.
const LOG_COMPLETE_FAILED = "[API v2] bundles: claim not finalised after a successful purchase (reads as unknown later)"
const LOG_RELEASE_FAILED = "[API v2] bundles: claim release failed (reference stays blocked)"
const LOG_UNKNOWN_FAILED = "[API v2] bundles: could not mark claim unknown (reads as unknown once stale)"
const LOG_AMBIGUOUS = "[API v2] bundles: ambiguous engine outcome; claim marked unknown"

function fail(status: V2ErrorStatus, message: string): V2HandlerResult {
  return { status, error: { status, message } }
}

const ok = (status: number, data: unknown): V2HandlerResult => ({ status, data })

const notFound = () => fail(404, MSG_BUNDLE_ORDER_NOT_FOUND)

// ---------------------------------------------------------------- helpers

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const money = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** A stored public order re-read through the allow-list (extra keys never leave). */
function publicFromStored(s: unknown, reference: string): PublicBundleOrder {
  const r = isObject(s) ? s : {}
  return {
    reference,
    network: String(r.network ?? ""),
    bundle: String(r.bundle ?? ""),
    recipient: String(r.recipient ?? ""),
    face_amount: money(r.face_amount),
    paid_amount: money(r.paid_amount ?? r.face_amount),
    cashback: money(r.cashback),
    status: mapCommissionStatus(r.status),
    created_at: typeof r.created_at === "string" ? r.created_at : null,
  }
}

/** Owner-scoped live row by engine code; null when missing, unreadable or throwing. */
async function safeOrderRead(deps: BundlesV2Deps, userId: string, code: string): Promise<BundleOrderRow | null> {
  try {
    return (await deps.getOrderByCode(userId, code)) ?? null
  } catch {
    return null
  }
}

async function truthy(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await fn()) === true
  } catch {
    return false
  }
}

async function safeRelease(deps: BundlesV2Deps, claimId: string, userId: string): Promise<void> {
  let released = false
  try {
    released = await deps.release(claimId, userId)
  } catch {
    released = false
  }
  if (!released) console.error(LOG_RELEASE_FAILED)
}

async function safeMarkUnknown(deps: BundlesV2Deps, claimId: string, userId: string, orderRef?: string): Promise<void> {
  let marked = false
  try {
    marked = orderRef ? await deps.markUnknown(claimId, userId, orderRef) : await deps.markUnknown(claimId, userId)
  } catch {
    marked = false
  }
  if (!marked) console.error(LOG_UNKNOWN_FAILED)
}

/** Best-effort URGENT admin alert; never throws and never changes the response. No phone numbers. */
async function safeAlert(deps: BundlesV2Deps, message: string): Promise<void> {
  try {
    await deps.alert(message)
  } catch {
    // alerting must never break the flow
  }
}

/**
 * Ambiguous outcome: the claim becomes unknown (keeping the engine order when there is one)
 * and admins get an urgent alert carrying only the user id and the client reference.
 */
async function markAmbiguous(deps: BundlesV2Deps, claimId: string, ctx: V2Context, reference: string, orderRef?: string): Promise<void> {
  await safeMarkUnknown(deps, claimId, ctx.userId, orderRef)
  await safeAlert(
    deps,
    `Standard bundle API outcome uncertain: claim ${reference}, user ${ctx.userId}${orderRef ? `, order ${orderRef}` : ""}. Check the wallet and the order before anything is resent.`
  )
}

const engineOrderRef = (r: unknown): string | undefined => {
  const order = isObject(r) ? r.order : undefined
  const code = isObject(order) ? order.reference_code : undefined
  return typeof code === "string" && code ? code : undefined
}

// ---------------------------------------------------------------- catalog

export function bundleCatalogHandler(deps: BundlesV2Deps) {
  return async (network: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const net = parseBundleNetwork(network)
    if (!net.ok) return fail(400, net.error)

    if (ctx.environment === "test") {
      return ok(200, { ...mapBundleCatalog(net.network, sandboxCatalog(net.engineNetwork)), sandbox: true })
    }

    let result: BundleCatalogResult
    try {
      result = await deps.loadCatalog(ctx.userId, net.engineNetwork)
    } catch {
      return fail(503, MSG_BUNDLE_CATALOG_UNAVAILABLE)
    }
    if (!isObject(result)) return fail(503, MSG_BUNDLE_CATALOG_UNAVAILABLE)
    if (result.kind === "closed") return fail(403, MSG_BUNDLE_NOT_AVAILABLE)
    if (result.kind !== "ok" || !Array.isArray(result.categories)) return fail(503, MSG_BUNDLE_CATALOG_UNAVAILABLE)
    return ok(200, mapBundleCatalog(net.network, result.categories))
  }
}

// ---------------------------------------------------------------- purchase

export function purchaseBundleHandler(deps: BundlesV2Deps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const parsed = parseBundlePurchaseBody(body)
    if (!parsed.ok) return fail(400, parsed.error)
    const input = parsed.value
    if (ctx.environment === "test") {
      if (input.kind !== "sandbox") return fail(400, MSG_TOKEN_ON_TEST_KEY)
      try {
        return await sandboxPurchase(deps, input, ctx)
      } catch {
        return fail(500, MSG_SANDBOX_UNAVAILABLE)
      }
    }
    if (input.kind === "sandbox") return fail(400, MSG_SANDBOX_TOKEN_ON_LIVE)
    return livePurchase(deps, input, ctx)
  }
}

async function livePurchase(deps: BundlesV2Deps, input: BundlePurchaseInput, ctx: V2Context): Promise<V2HandlerResult> {
  // 1. Claim the reference BEFORE anything that can charge. Decides replays too.
  let outcome: ClaimOutcome
  try {
    outcome = await deps.claim({
      userId: ctx.userId,
      apiV2KeyId: ctx.keyId,
      kind: "bundle",
      reference: input.reference,
      requestHash: bundleHash(input),
    })
  } catch {
    outcome = { kind: "error" }
  }
  switch (outcome.kind) {
    case "replay": {
      // The stored order, with its status refreshed from the owner-scoped live row (stored on any read failure).
      const stored = publicFromStored(outcome.response, input.reference)
      const live = await safeOrderRead(deps, ctx.userId, outcome.orderRef)
      return ok(200, { order: live ? { ...stored, status: mapCommissionStatus(live.status) } : stored, replayed: true })
    }
    case "conflict":
      return fail(409, MSG_REFERENCE_REUSED)
    case "in_progress":
      return fail(409, MSG_BUNDLE_IN_PROGRESS)
    case "unknown":
      return fail(409, MSG_BUNDLE_PRIOR_UNKNOWN)
    case "claimed":
      break
    default:
      return fail(503, MSG_CLAIM_UNAVAILABLE)
  }
  const claimId = outcome.claimId

  // 2. API surface switch (fail closed). A block frees the reference: nothing was charged.
  if (!(await truthy(() => deps.surfaceOpen()))) {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(403, MSG_BUNDLE_NOT_AVAILABLE)
  }

  // 3. Account phone gate (fail closed).
  if (!(await truthy(() => deps.phoneGate(ctx.userId)))) {
    await safeRelease(deps, claimId, ctx.userId)
    return fail(403, MSG_PHONE_GATE)
  }

  // 4. The engine.
  let result: BuyResult
  try {
    result = await deps.buy({
      userId: ctx.userId,
      token: input.token,
      phone: input.recipient.local,
      idempotencyKey: bundleEngineKey(claimId),
      ...(input.expectedPay !== undefined ? { expectedPay: input.expectedPay } : {}),
    })
  } catch {
    return ambiguous(deps, claimId, ctx, input.reference)
  }
  if (!isObject(result) || typeof result.ok !== "boolean") return ambiguous(deps, claimId, ctx, input.reference)

  if (!result.ok) {
    const c = classifyBundleRefusal(result, input.expectedPay)
    if (c.kind === "no_charge") {
      await safeRelease(deps, claimId, ctx.userId)
      return fail(c.status, c.message)
    }
    return ambiguous(deps, claimId, ctx, input.reference, engineOrderRef(result))
  }

  const order = result.order as unknown
  const code = isObject(order) ? order.reference_code : undefined
  // ok:true only follows a successful debit; anything else is a shape we do not understand.
  if (!isObject(order) || typeof code !== "string" || !code || order.payment_status !== "paid") {
    return ambiguous(deps, claimId, ctx, input.reference, engineOrderRef(result))
  }

  // 5. Success: store the engine code as order_ref and the allow-listed order as the response.
  const pub = mapBundleOrder(order, input.reference)
  let completed = false
  try {
    completed = await deps.complete(claimId, code, pub, ctx.userId)
  } catch {
    completed = false
  }
  // The money moved: answer 201 regardless. Fall back to unknown WITH the engine order, so the
  // claim keeps the order link for support and the lookup (never re-run), and alert admins.
  if (!completed) {
    console.error(LOG_COMPLETE_FAILED)
    await markAmbiguous(deps, claimId, ctx, input.reference, code)
  }
  return ok(201, { order: pub })
}

async function ambiguous(deps: BundlesV2Deps, claimId: string, ctx: V2Context, reference: string, orderRef?: string): Promise<V2HandlerResult> {
  await markAmbiguous(deps, claimId, ctx, reference, orderRef)
  console.error(LOG_AMBIGUOUS)
  return fail(500, MSG_BUNDLE_OUTCOME_UNKNOWN)
}

// ---------------------------------------------------------------- sandbox

function sandboxResponse(prior: BundleSandboxOrder): Record<string, unknown> {
  return isObject(prior.response) ? prior.response : {}
}

function sandboxMatches(input: BundlePurchaseInput, prior: BundleSandboxOrder): boolean {
  if (prior.action !== "standard_bundle") return false
  const r = sandboxResponse(prior)
  const rec = normalizeRecipient(r.phone)
  return r.sandbox_token === input.token && rec.ok && rec.local === input.recipient.local
}

function mapSandboxOrder(prior: BundleSandboxOrder): PublicBundleOrder {
  const r = sandboxResponse(prior)
  return mapBundleOrder(
    {
      network: r.network,
      bundle_display: r.bundle,
      beneficiary_phone: r.phone,
      amount: r.face_amount,
      paid_amount: r.paid_amount,
      cashback_amount: r.cashback,
      status: prior.status,
      created_at: prior.created_at,
    },
    prior.reference
  )
}

async function sandboxPurchase(deps: BundlesV2Deps, input: BundlePurchaseInput, ctx: V2Context): Promise<V2HandlerResult> {
  const bundle = findSandboxBundle(input.token)
  if (!bundle) return fail(400, "bundle_token is invalid")
  const replay = (prior: BundleSandboxOrder) => ok(200, { order: mapSandboxOrder(prior), replayed: true, sandbox: true })

  const prior = await deps.sandbox.getOrder(ctx.userId, input.reference)
  if (prior) return sandboxMatches(input, prior) ? replay(prior) : fail(409, MSG_REFERENCE_REUSED)

  // Sandbox charges face value (no cashback).
  const price = bundle.amount
  if (input.expectedPay !== undefined && Math.round(input.expectedPay * 100) !== Math.round(price * 100)) {
    return fail(409, bundlePriceChangedMessage(input.expectedPay, { faceAmount: price, payAmount: price, customerCashback: 0 }))
  }

  const recipient = input.recipient.local
  const placed = await deps.sandbox.place({
    userId: ctx.userId,
    apiV2KeyId: ctx.keyId,
    action: "standard_bundle",
    reference: input.reference,
    request: { bundle_token: input.token, recipient, reference: input.reference },
    price,
    orderFields: { ...sandboxOrderFields(bundle, recipient), sandbox_token: input.token },
  })
  if (!placed.success) {
    if (placed.status === 402) return fail(402, `INSUFFICIENT_BALANCE: test balance is too low; required ${price.toFixed(2)}`)
    if (placed.status === 409) {
      // Insert race: answer as a replay when it is the same order.
      const again = await deps.sandbox.getOrder(ctx.userId, input.reference)
      if (again && sandboxMatches(input, again)) return replay(again)
      return fail(409, MSG_REFERENCE_REUSED)
    }
    return fail(500, MSG_SANDBOX_FAILED)
  }
  const o = placed.order
  const order = mapBundleOrder(
    {
      network: bundle.network,
      bundle_display: bundle.display,
      beneficiary_phone: recipient,
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

export function bundleOrderHandler(deps: BundlesV2Deps) {
  return async (reference: string, ctx: V2Context): Promise<V2HandlerResult> => {
    // Malformed, missing, foreign, in-progress and unknown all get this one body.
    const ref = parseReference(reference)
    if (!ref.ok) return notFound()

    if (ctx.environment === "test") {
      let prior: BundleSandboxOrder | null
      try {
        prior = await deps.sandbox.getOrder(ctx.userId, ref.reference)
      } catch {
        return fail(500, MSG_SANDBOX_UNAVAILABLE)
      }
      if (!prior || prior.action !== "standard_bundle") return notFound()
      return ok(200, { order: mapSandboxOrder(prior), claim: null, sandbox: true })
    }

    let claim: Awaited<ReturnType<BundlesV2Deps["getClaim"]>>
    try {
      claim = await deps.getClaim(ctx.userId, ref.reference)
    } catch {
      claim = null
    }
    if (!claim) return notFound()
    // An unknown claim that kept the engine's order (e.g. the purchase succeeded but the claim could not be
    // finalised): when the owner-scoped live row says it was PAID, the money moved, so show the order.
    if (claim.status === "unknown" && claim.orderRef) {
      const paid = await safeOrderRead(deps, ctx.userId, claim.orderRef)
      if (paid && paid.payment_status === "paid") return ok(200, { order: mapBundleOrder(paid, ref.reference), claim: null })
    }
    // The caller's own claim that is still running or ambiguous: say so (never a 404, which reads as "never created").
    const pending = mapClaimState(claim, ref.reference, deps.now())
    if (pending) return ok(200, { order: null, claim: pending })
    if (claim.status !== "done" || !claim.orderRef) return notFound()

    const live = await safeOrderRead(deps, ctx.userId, claim.orderRef)
    if (!isObject(claim.response)) {
      return live ? ok(200, { order: mapBundleOrder(live, ref.reference), claim: null }) : notFound()
    }
    const stored = publicFromStored(claim.response, ref.reference)
    return ok(200, { order: live ? { ...stored, status: mapCommissionStatus(live.status) } : stored, claim: null })
  }
}

// ---------------------------------------------------------------- list

export function bundleListHandler(deps: BundlesV2Deps) {
  return async (ctx: V2Context): Promise<V2HandlerResult> => {
    if (ctx.environment === "test") {
      let rows: BundleSandboxOrder[] | null
      try {
        rows = await deps.sandbox.listOrders(ctx.userId, "standard_bundle", BUNDLE_LIST_LIMIT)
      } catch {
        return fail(500, MSG_SANDBOX_UNAVAILABLE)
      }
      if (!rows) return fail(503, MSG_UNAVAILABLE)
      const orders = rows
        .filter((r) => r.action === "standard_bundle")
        .slice(0, BUNDLE_LIST_LIMIT)
        .map(mapSandboxOrder)
      return ok(200, { orders, sandbox: true })
    }

    let claims: Awaited<ReturnType<BundlesV2Deps["listClaims"]>>
    try {
      claims = await deps.listClaims(ctx.userId, BUNDLE_LIST_LIMIT)
    } catch {
      return fail(503, MSG_UNAVAILABLE)
    }
    // null = the claim store could not be read: fail closed (503), never an empty 200.
    if (!Array.isArray(claims)) return fail(503, MSG_UNAVAILABLE)
    const done = claims
      .slice(0, BUNDLE_LIST_LIMIT)
      .filter((c): c is { reference: string; orderRef: string; status: string } => c.status === "done" && !!c.orderRef)
    if (done.length === 0) return ok(200, { orders: [] })

    let rows: BundleOrderRow[] | null
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
      return row ? [mapBundleOrder(row, c.reference)] : []
    })
    return ok(200, { orders })
  }
}

// Re-exported for the docs registry drift tests.
export { BUNDLE_CATALOG_VALID_SECONDS, MSG_BUNDLE_NOT_AVAILABLE, MSG_BUNDLE_UNAVAILABLE }
export type { BundleApiNetwork }
