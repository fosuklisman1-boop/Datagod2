/**
 * Developer API v2 data endpoints: packages, single purchase, bulk purchase,
 * MTN number verification and order lookup. MONEY PATH (tier 1).
 *
 * Every decision lives here, over injected DataDeps, so tests need no network.
 * Routes (app/api/v2/**) only wire real deps (see data-deps.ts) and withV2.
 *
 * Purchase check order (each step short-circuits, nothing is charged before
 * the last one):
 *   parse body (price-like fields rejected) -> replay lookup by (user,
 *   reference): same content = 200 replay, different = 409 -> account
 *   phone gate (403, fail closed) -> package (503 unreadable / 404) ->
 *   role price (server side) -> network prefix (400) -> MTN whitelist
 *   (409) -> placeV2Order (atomic RPC) -> schedule fulfillment only for a
 *   NEW placement.
 *
 * Machine codes travel in the error message prefix ("NETWORK_MISMATCH: ...")
 * because plan 1's envelope only carries { code: <http status>, message }.
 * Messages are fixed strings: no SQL text, no recipient numbers, no echo of
 * input other than the caller's own reference.
 */
import { validateNetworkPrefix } from "@/lib/phone-format"
import type { PrefixValidationConfig } from "@/lib/network-prefix-config"
import { NO_CUSTOM_PRICES, type CustomPrices } from "@/lib/pricing/package-price"
import type { V2Context, V2HandlerResult } from "../handler"
import type { V2ErrorStatus } from "../envelope"
import {
  findPackage,
  mapOrder,
  normalizeRecipient,
  parseBulkBody,
  parseNetwork,
  parsePurchaseBody,
  parseVolume,
  parseReference,
  priceForRole,
  type OrderDbRow,
  type PackageRow,
  type PublicOrder,
  type PurchaseInput,
} from "../data-orders"
import {
  purchaseDescription,
  storageRecipient,
  type OrderRow,
  type PlaceParams,
  type PlaceResult,
} from "../order-store"
import type { FulfillmentTarget } from "../fulfillment"

// ---------------------------------------------------------------- deps

/** Order-store functions with the client already bound (see data-deps.ts). */
export interface DataStore {
  /** null = catalog unreadable (503), distinct from an empty catalog. */
  listAvailablePackages(dbNetwork?: string): Promise<PackageRow[] | null>
  getOrderByReference(userId: string, reference: string): Promise<OrderRow | null>
  getOrdersByReferences(userId: string, references: string[]): Promise<Map<string, OrderRow> | null>
  getWalletBalance(userId: string): Promise<number | null>
  placeV2Order(p: PlaceParams): Promise<PlaceResult>
}

/** What lib/sandbox.ts getSandboxOrder returns. */
export interface SandboxOrderLike {
  reference: string
  action: string
  response: unknown
  price: number | string
  created_at: string
  status: string
}

export interface SandboxPlaceParams {
  userId: string
  apiV2KeyId: string
  action: "data_order"
  reference: string
  request: Record<string, unknown>
  price: number
  orderFields: Record<string, unknown>
}

export type SandboxPlaceResult =
  | { success: true; order: Record<string, unknown>; newBalance: number }
  | { success: false; error: string; status: number }

export interface DataDeps {
  store: DataStore
  prefixConfig(): Promise<PrefixValidationConfig>
  /**
   * MTN whitelist verdict per LOCAL number: true registered, false NOT
   * registered (block, no charge), null/absent = check unavailable (fail
   * open, like v1; the fulfillment-time hold stays the backstop).
   */
  verifyMtn(locals: string[]): Promise<Map<string, boolean | null>>
  /**
   * Whether a false verdict blocks (the admin "block unverified numbers"
   * toggle). Asked only when some verdict is false; a throw counts as off
   * (fail open). verify-number reports the verdict regardless.
   */
  mtnBlocking(): Promise<boolean>
  /** The caller's custom prices (empty unless they are on custom pricing). Throws CustomPriceReadError on a read failure. */
  customPrices(userId: string): Promise<CustomPrices>
  /**
   * Account-holder phone gate (lib/phone-verify-guard checkPhoneVerified,
   * fail closed). Live purchase/bulk only, after replay classification and
   * before any MTN check or placement. A throw counts as blocked.
   */
  phoneGate(userId: string): Promise<{ allowed: boolean }>
  sandbox: {
    getOrder(userId: string, reference: string): Promise<SandboxOrderLike | null>
    /** One query for a batch; null on read error (caller fails closed). */
    getOrders(userId: string, references: string[]): Promise<Map<string, SandboxOrderLike> | null>
    place(p: SandboxPlaceParams): Promise<SandboxPlaceResult>
    balance(userId: string): Promise<number>
  }
  /** Single purchase: one order's dispatch via after(). */
  schedule(o: FulfillmentTarget): void
  /**
   * Bulk: called ONCE after the placement loop with every NEW placement;
   * one after() callback with bounded provider concurrency.
   */
  scheduleBatch(targets: FulfillmentTarget[]): void
  now(): Date
}

// ---------------------------------------------------------------- messages

export const MSG_PACKAGE_NOT_FOUND = "Package not found or unavailable"
export const MSG_NETWORK_MISMATCH = "NETWORK_MISMATCH: recipient number does not match the selected network"
export const MSG_REFERENCE_REUSED = "REFERENCE_REUSED: reference already used for a different order"
export const MSG_NOT_REGISTERED =
  "RECIPIENT_NOT_REGISTERED: recipient is not registered for MTN data; nothing was charged"
export const MSG_ORDER_FAILED = "Order could not be placed"
export const MSG_ORDER_NOT_FOUND = "Order not found"
export const MSG_LOOKUP_FAILED = "Could not check existing orders; nothing was charged"
export const MSG_UNAVAILABLE = "Service temporarily unavailable"
export const MSG_PHONE_GATE = "PHONE_NOT_VERIFIED: verify your account phone number in the dashboard to continue"
export const MSG_NOT_ATTEMPTED = "NOT_ATTEMPTED: retry this item"
const MSG_BODY_OBJECT = "Request body must be a JSON object"

/**
 * Bulk stops STARTING placements after this long: fulfillment is dispatched
 * via after(), which only runs once the response is sent, so a request that
 * hit maxDuration would leave paid orders undispatched. Unstarted items are
 * reported NOT_ATTEMPTED; a resend replays the placed ones and places the rest.
 * 25 s of the route's 300 s maxDuration, so most of the budget is left for
 * the after() dispatch. The docs text is built from this constant.
 */
export const BULK_DEADLINE_MS = 25_000

function insufficient(required: number, sandbox: boolean): string {
  return `INSUFFICIENT_BALANCE: ${sandbox ? "test" : "wallet"} balance is too low; required ${required.toFixed(2)}`
}

function fail(status: V2ErrorStatus, message: string): V2HandlerResult {
  return { status, error: { status, message } }
}

const ok = (status: number, data: unknown): V2HandlerResult => ({ status, data })

// ---------------------------------------------------------------- helpers

const cents = (n: number) => Math.round(Number(n) * 100)

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Same network (canonical), same numeric volume, same LOCAL recipient. */
function sameContent(input: PurchaseInput, prior: { network: unknown; volume_gb: unknown; recipient: unknown }): boolean {
  const net = parseNetwork(prior.network)
  if (!net.ok || net.network !== input.network) return false
  const gb = Number(prior.volume_gb)
  if (!Number.isFinite(gb) || gb !== input.gb) return false
  const rec = normalizeRecipient(prior.recipient)
  return rec.ok && rec.local === input.local
}

function liveMatches(input: PurchaseInput, row: OrderRow): boolean {
  return sameContent(input, { network: row.network, volume_gb: row.volume_gb, recipient: row.recipient_phone })
}

function sandboxResponse(prior: SandboxOrderLike): Record<string, unknown> {
  return isObject(prior.response) ? prior.response : {}
}

function sandboxMatches(input: PurchaseInput, prior: SandboxOrderLike): boolean {
  if (prior.action !== "data_order") return false
  const r = sandboxResponse(prior)
  return sameContent(input, { network: r.network, volume_gb: r.volume_gb, recipient: r.recipient })
}

function mapSandboxOrder(prior: SandboxOrderLike): PublicOrder {
  const r = sandboxResponse(prior)
  return mapOrder({
    api_reference: prior.reference,
    network: String(r.network ?? ""),
    volume_gb: r.volume_gb as number,
    price: prior.price,
    recipient_phone: String(r.recipient ?? ""),
    status: prior.status,
    created_at: prior.created_at,
  })
}

function orderFromInput(input: PurchaseInput, price: number, status: unknown, createdAt: string): PublicOrder {
  const row: OrderDbRow = {
    api_reference: input.reference,
    network: input.dbNetwork,
    volume_gb: input.gb,
    price,
    recipient_phone: storageRecipient(input),
    status,
    created_at: createdAt,
  }
  return mapOrder(row)
}

async function safeVerify(deps: DataDeps, locals: string[]): Promise<Map<string, boolean | null>> {
  if (locals.length === 0) return new Map()
  try {
    return await deps.verifyMtn(locals)
  } catch {
    // Guard unavailable: fail open (same contract as the guard itself).
    return new Map()
  }
}

async function safeBlocking(deps: DataDeps): Promise<boolean> {
  try {
    return (await deps.mtnBlocking()) === true
  } catch {
    return false
  }
}

/** Unpriced rows (price null/0/negative/non-numeric) are never listed or sold. */
function usable(rows: PackageRow[]): PackageRow[] {
  return rows.filter((r) => {
    const n = Number(r.price)
    return r.price !== null && Number.isFinite(n) && n > 0
  })
}

/** Account phone gate; fails CLOSED (a throw is a block). */
async function phoneGateOk(deps: DataDeps, userId: string): Promise<boolean> {
  try {
    return (await deps.phoneGate(userId)).allowed === true
  } catch {
    return false
  }
}

function prefixOk(cfg: PrefixValidationConfig, input: PurchaseInput): boolean {
  if (!cfg.enabled) return true
  return validateNetworkPrefix(input.dbNetwork, input.local, cfg.map).ok
}

interface Priced {
  input: PurchaseInput
  pkg: PackageRow
  price: number
}

function target(orderId: string, input: PurchaseInput): FulfillmentTarget {
  return { orderId, dbNetwork: input.dbNetwork, gb: input.gb, msisdn: input.msisdn, local: input.local }
}

function placeParams(ctx: V2Context, p: Priced): PlaceParams {
  return {
    userId: ctx.userId,
    apiV2KeyId: ctx.keyId,
    packageId: p.pkg.id,
    dbNetwork: p.input.dbNetwork,
    gb: p.input.gb,
    price: p.price,
    recipientPhone: storageRecipient(p.input),
    reference: p.input.reference,
    description: purchaseDescription(p.input.network, p.input.gb, p.input.reference),
  }
}

function sandboxParams(ctx: V2Context, p: Priced): SandboxPlaceParams {
  const recipient = storageRecipient(p.input)
  return {
    userId: ctx.userId,
    apiV2KeyId: ctx.keyId,
    action: "data_order",
    reference: p.input.reference,
    request: { network: p.input.network, volume_gb: p.input.gb, recipient, reference: p.input.reference },
    price: p.price,
    orderFields: { network: p.input.network, volume_gb: p.input.gb, price: p.price, recipient },
  }
}

function sandboxCreatedAt(deps: DataDeps, order: Record<string, unknown>): string {
  return typeof order.created_at === "string" ? order.created_at : deps.now().toISOString()
}

/** Order for an RPC-reported replay (race): re-read it, else build it from the request. */
async function liveReplayOrder(
  deps: DataDeps,
  ctx: V2Context,
  p: Priced,
  res: { status?: string; createdAt: string }
): Promise<PublicOrder> {
  const row = await deps.store.getOrderByReference(ctx.userId, p.input.reference)
  if (row) return mapOrder(row)
  return orderFromInput(p.input, p.price, res.status ?? "pending", res.createdAt)
}

// ---------------------------------------------------------------- purchase

export function purchaseHandler(deps: DataDeps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const parsed = parsePurchaseBody(body)
    if (!parsed.ok) return fail(400, parsed.error)
    const input = parsed.value
    return ctx.environment === "test" ? sandboxPurchase(deps, input, ctx) : livePurchase(deps, input, ctx)
  }
}

/** null = the read failed; the caller answers 503 and places nothing. */
async function loadCustom(deps: DataDeps, ctx: V2Context): Promise<CustomPrices | null> {
  try {
    return await deps.customPrices(ctx.userId)
  } catch {
    return null
  }
}

/** Package + effective (custom or role) price + prefix, shared by live and sandbox. */
async function priceAndValidate(
  deps: DataDeps,
  input: PurchaseInput,
  ctx: V2Context
): Promise<{ ok: true; priced: Priced } | { ok: false; result: V2HandlerResult }> {
  const rows = await deps.store.listAvailablePackages(input.dbNetwork)
  if (!rows) return { ok: false, result: fail(503, MSG_UNAVAILABLE) }
  const pkg = findPackage(usable(rows), input.dbNetwork, input.gb)
  if (!pkg) return { ok: false, result: fail(404, MSG_PACKAGE_NOT_FOUND) }
  const custom = await loadCustom(deps, ctx)
  if (!custom) return { ok: false, result: fail(503, MSG_UNAVAILABLE) }
  const price = priceForRole(ctx.role, pkg, custom)
  if (!prefixOk(await deps.prefixConfig(), input)) return { ok: false, result: fail(400, MSG_NETWORK_MISMATCH) }
  return { ok: true, priced: { input, pkg, price } }
}

async function livePurchase(deps: DataDeps, input: PurchaseInput, ctx: V2Context): Promise<V2HandlerResult> {
  // 1. Replay lookup FIRST: a replay touches no package, guard, money or provider.
  const existing = await deps.store.getOrderByReference(ctx.userId, input.reference)
  if (existing) {
    if (!liveMatches(input, existing)) return fail(409, MSG_REFERENCE_REUSED)
    return ok(200, { order: mapOrder(existing), replayed: true })
  }

  // 2. Account phone gate (fail closed) before anything that can lead to a charge.
  if (!(await phoneGateOk(deps, ctx.userId))) return fail(403, MSG_PHONE_GATE)

  // 3. Package, server-side price, prefix.
  const v = await priceAndValidate(deps, input, ctx)
  if (!v.ok) return v.result
  const p = v.priced

  // 4. MTN whitelist: an explicit "not registered" blocks with no charge
  //    while the admin blocking toggle is on.
  if (input.network === "MTN") {
    const verdicts = await safeVerify(deps, [input.local])
    if (verdicts.get(input.local) === false && (await safeBlocking(deps))) return fail(409, MSG_NOT_REGISTERED)
  }

  // 5. Atomic placement.
  const res = await deps.store.placeV2Order(placeParams(ctx, p))
  if (!res.ok) {
    switch (res.code) {
      case "INSUFFICIENT_BALANCE":
        return fail(402, insufficient(res.required ?? p.price, false))
      case "WALLET_NOT_FOUND":
        return fail(402, insufficient(p.price, false))
      case "REFERENCE_REUSED":
        return fail(409, MSG_REFERENCE_REUSED)
      default:
        return fail(500, MSG_ORDER_FAILED)
    }
  }
  if (res.replayed) {
    return ok(200, { order: await liveReplayOrder(deps, ctx, p, res), replayed: true })
  }

  // 6. Only a NEW placement dispatches, exactly once.
  deps.schedule(target(res.orderId, input))
  return ok(201, {
    order: orderFromInput(input, p.price, "pending", res.createdAt),
    new_balance: res.newBalance !== undefined ? Math.round(res.newBalance * 100) / 100 : null,
  })
}

async function sandboxPurchase(deps: DataDeps, input: PurchaseInput, ctx: V2Context): Promise<V2HandlerResult> {
  const prior = await deps.sandbox.getOrder(ctx.userId, input.reference)
  if (prior) {
    if (!sandboxMatches(input, prior)) return fail(409, MSG_REFERENCE_REUSED)
    return ok(200, { order: mapSandboxOrder(prior), replayed: true, sandbox: true })
  }

  const v = await priceAndValidate(deps, input, ctx)
  if (!v.ok) return v.result
  const p = v.priced

  const placed = await deps.sandbox.place(sandboxParams(ctx, p))
  if (!placed.success) {
    if (placed.status === 402) return fail(402, insufficient(p.price, true))
    if (placed.status === 409) {
      // Duplicate insert race: answer as a replay when it is the same order.
      const again = await deps.sandbox.getOrder(ctx.userId, input.reference)
      if (again && sandboxMatches(input, again)) {
        return ok(200, { order: mapSandboxOrder(again), replayed: true, sandbox: true })
      }
      return fail(409, MSG_REFERENCE_REUSED)
    }
    return fail(500, MSG_ORDER_FAILED)
  }
  return ok(201, {
    order: orderFromInput(input, p.price, placed.order.status ?? "pending", sandboxCreatedAt(deps, placed.order)),
    new_balance: placed.newBalance,
    sandbox: true,
  })
}

// ---------------------------------------------------------------- bulk

/** Every per-item `error` a bulk result can carry; the docs list each one. */
export const BULK_ITEM_ERRORS = ["INSUFFICIENT_BALANCE", "REFERENCE_REUSED", "FAILED", MSG_NOT_ATTEMPTED] as const
export type BulkItemError = (typeof BULK_ITEM_ERRORS)[number]

export interface BulkResult {
  reference: string
  status: "placed" | "replayed" | "failed"
  order?: PublicOrder
  error?: BulkItemError
}

type Slot = { kind: "new"; p: Priced } | { kind: "replay"; reference: string; order: PublicOrder }

/** A classified item before pricing: replays need no package (it may since be disabled). */
type Classified = { kind: "new"; index: number; input: PurchaseInput } | { kind: "replay"; reference: string; order: PublicOrder }

/**
 * Package + prefix validation for the NEW items only, one catalog read.
 * Any failure rejects the whole batch (400 with the index, or 503).
 */
async function priceNewItems(
  deps: DataDeps,
  classified: Classified[],
  ctx: V2Context
): Promise<{ ok: true; slots: Slot[] } | { ok: false; result: V2HandlerResult }> {
  const hasNew = classified.some((c) => c.kind === "new")
  let packages: PackageRow[] = []
  let cfg: PrefixValidationConfig | null = null
  let custom: CustomPrices = NO_CUSTOM_PRICES
  if (hasNew) {
    const rows = await deps.store.listAvailablePackages()
    if (!rows) return { ok: false, result: fail(503, MSG_UNAVAILABLE) }
    packages = usable(rows)
    cfg = await deps.prefixConfig()
    const c = await loadCustom(deps, ctx)
    if (!c) return { ok: false, result: fail(503, MSG_UNAVAILABLE) }
    custom = c
  }
  const slots: Slot[] = []
  for (const c of classified) {
    if (c.kind === "replay") {
      slots.push(c)
      continue
    }
    const pkg = findPackage(packages, c.input.dbNetwork, c.input.gb)
    if (!pkg) return { ok: false, result: fail(400, `orders[${c.index}]: ${MSG_PACKAGE_NOT_FOUND}`) }
    if (!prefixOk(cfg!, c.input)) return { ok: false, result: fail(400, `orders[${c.index}]: ${MSG_NETWORK_MISMATCH}`) }
    slots.push({ kind: "new", p: { input: c.input, pkg, price: priceForRole(ctx.role, pkg, custom) } })
  }
  return { ok: true, slots }
}

export function bulkHandler(deps: DataDeps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    const startedAt = deps.now().getTime()
    // 1. Parse EVERYTHING before any lookup.
    const parsed = parseBulkBody(body)
    if (!parsed.ok) {
      return fail(400, parsed.index === undefined ? parsed.error : `orders[${parsed.index}]: ${parsed.error}`)
    }
    const items = parsed.items
    return ctx.environment === "test"
      ? sandboxBulk(deps, items, ctx, startedAt)
      : liveBulk(deps, items, ctx, startedAt)
  }
}

function pastDeadline(deps: DataDeps, startedAt: number): boolean {
  return deps.now().getTime() - startedAt > BULK_DEADLINE_MS
}

async function liveBulk(deps: DataDeps, items: PurchaseInput[], ctx: V2Context, startedAt: number): Promise<V2HandlerResult> {
  // 2. Classify replay / conflict / new BEFORE any validation of new items or money.
  const existing = await deps.store.getOrdersByReferences(
    ctx.userId,
    items.map((i) => i.reference)
  )
  if (!existing) return fail(500, MSG_LOOKUP_FAILED)
  const classified: Classified[] = []
  for (let i = 0; i < items.length; i++) {
    const input = items[i]
    const row = existing.get(input.reference)
    if (!row) classified.push({ kind: "new", index: i, input })
    else if (liveMatches(input, row)) classified.push({ kind: "replay", reference: input.reference, order: mapOrder(row) })
    else return fail(409, `orders[${i}]: ${MSG_REFERENCE_REUSED}`)
  }

  // 3. Validate the NEW items (package, price, prefix); any failure rejects the batch.
  const v = await priceNewItems(deps, classified, ctx)
  if (!v.ok) return v.result
  const slots = v.slots

  // 4. Account phone gate (fail closed) when anything new would be placed.
  if (slots.some((s) => s.kind === "new") && !(await phoneGateOk(deps, ctx.userId))) {
    return fail(403, MSG_PHONE_GATE)
  }

  // 5. MTN whitelist for NEW items, one batch call (bounded at 10 s); unregistered are skipped.
  const mtnLocals = [
    ...new Set(
      slots.flatMap((s) => (s.kind === "new" && s.p.input.network === "MTN" ? [s.p.input.local] : []))
    ),
  ]
  const verdicts = await safeVerify(deps, mtnLocals)
  const blocking = [...verdicts.values()].includes(false) && (await safeBlocking(deps))
  const skipped: Array<{ reference: string; reason: "NOT_REGISTERED" }> = []
  const toPlace = new Set<Slot>()
  for (const s of slots) {
    if (s.kind !== "new") continue
    if (blocking && s.p.input.network === "MTN" && verdicts.get(s.p.input.local) === false) {
      skipped.push({ reference: s.p.input.reference, reason: "NOT_REGISTERED" })
    } else {
      toPlace.add(s)
    }
  }

  // 6. Whole-batch balance check (no charge on failure). No wallet row reads
  //    as a zero balance: 402, same as single purchase.
  const neededCents = [...toPlace].reduce((sum, s) => sum + (s.kind === "new" ? cents(s.p.price) : 0), 0)
  if (neededCents > 0) {
    const balance = await deps.store.getWalletBalance(ctx.userId)
    if (balance === null || cents(balance) < neededCents) return fail(402, insufficient(neededCents / 100, false))
  }

  // 7. Sequential placement; a failure marks the item and the batch continues.
  //    Past the deadline no new placement STARTS (NOT_ATTEMPTED).
  //    NEW placements are collected and dispatched ONCE after the loop (one
  //    after() callback, bounded concurrency); the finally makes sure orders
  //    already paid for are dispatched even if a later step throws.
  const results: BulkResult[] = []
  const placed: FulfillmentTarget[] = []
  let chargedCents = 0
  try {
    for (const s of slots) {
      if (s.kind === "replay") {
        results.push({ reference: s.reference, status: "replayed", order: s.order })
        continue
      }
      const ref = s.p.input.reference
      if (!toPlace.has(s)) continue
      if (pastDeadline(deps, startedAt)) {
        results.push({ reference: ref, status: "failed", error: MSG_NOT_ATTEMPTED })
        continue
      }
      const res = await deps.store.placeV2Order(placeParams(ctx, s.p))
      if (!res.ok) {
        results.push({
          reference: ref,
          status: "failed",
          error: res.code === "WALLET_NOT_FOUND" ? "INSUFFICIENT_BALANCE" : res.code,
        })
        continue
      }
      if (res.replayed) {
        results.push({ reference: ref, status: "replayed", order: await liveReplayOrder(deps, ctx, s.p, res) })
        continue
      }
      chargedCents += cents(s.p.price)
      placed.push(target(res.orderId, s.p.input))
      results.push({ reference: ref, status: "placed", order: orderFromInput(s.p.input, s.p.price, "pending", res.createdAt) })
    }
  } finally {
    if (placed.length > 0) deps.scheduleBatch(placed)
  }

  return ok(200, { results, skipped, total_charged: chargedCents / 100 })
}

async function sandboxBulk(deps: DataDeps, items: PurchaseInput[], ctx: V2Context, startedAt: number): Promise<V2HandlerResult> {
  // One query for the batch's existing sandbox orders.
  const existing = await deps.sandbox.getOrders(
    ctx.userId,
    items.map((i) => i.reference)
  )
  if (!existing) return fail(500, MSG_LOOKUP_FAILED)
  const classified: Classified[] = []
  for (let i = 0; i < items.length; i++) {
    const input = items[i]
    const prior = existing.get(input.reference)
    if (!prior) classified.push({ kind: "new", index: i, input })
    else if (sandboxMatches(input, prior)) classified.push({ kind: "replay", reference: input.reference, order: mapSandboxOrder(prior) })
    else return fail(409, `orders[${i}]: ${MSG_REFERENCE_REUSED}`)
  }

  const v = await priceNewItems(deps, classified, ctx)
  if (!v.ok) return v.result
  const slots = v.slots

  const neededCents = slots.reduce((sum, s) => sum + (s.kind === "new" ? cents(s.p.price) : 0), 0)
  if (neededCents > 0 && cents(await deps.sandbox.balance(ctx.userId)) < neededCents) {
    return fail(402, insufficient(neededCents / 100, true))
  }

  const results: BulkResult[] = []
  let chargedCents = 0
  for (const s of slots) {
    if (s.kind === "replay") {
      results.push({ reference: s.reference, status: "replayed", order: s.order })
      continue
    }
    const ref = s.p.input.reference
    if (pastDeadline(deps, startedAt)) {
      results.push({ reference: ref, status: "failed", error: MSG_NOT_ATTEMPTED })
      continue
    }
    const placed = await deps.sandbox.place(sandboxParams(ctx, s.p))
    if (placed.success) {
      chargedCents += cents(s.p.price)
      results.push({
        reference: ref,
        status: "placed",
        order: orderFromInput(s.p.input, s.p.price, placed.order.status ?? "pending", sandboxCreatedAt(deps, placed.order)),
      })
    } else if (placed.status === 409) {
      const again = await deps.sandbox.getOrder(ctx.userId, ref)
      if (again && sandboxMatches(s.p.input, again)) {
        results.push({ reference: ref, status: "replayed", order: mapSandboxOrder(again) })
      } else {
        results.push({ reference: ref, status: "failed", error: "REFERENCE_REUSED" })
      }
    } else {
      results.push({ reference: ref, status: "failed", error: placed.status === 402 ? "INSUFFICIENT_BALANCE" : "FAILED" })
    }
  }

  return ok(200, { results, skipped: [], total_charged: chargedCents / 100, sandbox: true })
}

// ---------------------------------------------------------------- verify-number

export function verifyNumberHandler(deps: DataDeps) {
  return async (body: unknown, ctx: V2Context): Promise<V2HandlerResult> => {
    if (!isObject(body)) return fail(400, MSG_BODY_OBJECT)
    const net = parseNetwork(body.network)
    if (!net.ok) return fail(400, net.error)
    const rec = normalizeRecipient(body.phone)
    if (!rec.ok) return fail(400, "phone must be a valid Ghana mobile number")

    // Test keys never reach a provider.
    if (ctx.environment === "test") return ok(200, { allowed: true, checked: false, sandbox: true })
    if (net.network !== "MTN") return ok(200, { allowed: true, checked: false })

    const verdict = (await safeVerify(deps, [rec.local])).get(rec.local)
    if (verdict === true) return ok(200, { allowed: true, checked: true })
    if (verdict === false) return ok(200, { allowed: false, checked: true })
    // Unavailable: fail open, like the checkout preview.
    return ok(200, { allowed: true, checked: false })
  }
}

// ---------------------------------------------------------------- order lookup

export function orderLookupHandler(deps: DataDeps) {
  return async (reference: string, ctx: V2Context): Promise<V2HandlerResult> => {
    // Malformed, missing and another user's reference all get this one body.
    const notFound = fail(404, MSG_ORDER_NOT_FOUND)
    const ref = parseReference(reference)
    if (!ref.ok) return notFound
    if (ctx.environment === "test") {
      const prior = await deps.sandbox.getOrder(ctx.userId, ref.reference)
      if (!prior || prior.action !== "data_order") return notFound
      return ok(200, { order: mapSandboxOrder(prior), sandbox: true })
    }
    const row = await deps.store.getOrderByReference(ctx.userId, ref.reference)
    if (!row) return notFound
    return ok(200, { order: mapOrder(row) })
  }
}

// ---------------------------------------------------------------- packages

export interface PackagesQuery {
  network?: string | null
  size_gb?: string | null
}

export function listPackagesHandler(deps: DataDeps) {
  return async (query: PackagesQuery, ctx: V2Context): Promise<V2HandlerResult> => {
    let dbNetwork: string | undefined
    if (query.network) {
      const net = parseNetwork(query.network)
      if (!net.ok) return fail(400, net.error)
      dbNetwork = net.dbNetwork
    }
    let gb: number | undefined
    if (query.size_gb) {
      const vol = parseVolume(query.size_gb)
      if (!vol.ok) return fail(400, "size_gb must be a positive number up to 1000 with at most 3 decimals")
      gb = vol.gb
    }

    const rows = await deps.store.listAvailablePackages(dbNetwork)
    if (!rows) return fail(503, MSG_UNAVAILABLE)
    const custom = await loadCustom(deps, ctx)
    if (!custom) return fail(503, MSG_UNAVAILABLE)
    const packages: Array<{ network: string; size_gb: number; price: number }> = []
    for (const r of usable(rows)) {
      const net = parseNetwork(r.network)
      if (!net.ok) continue
      if (typeof r.size !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(r.size)) continue
      const size = Number(r.size)
      if (gb !== undefined && size !== gb) continue
      packages.push({ network: net.network, size_gb: size, price: cents(priceForRole(ctx.role, r, custom)) / 100 })
    }
    packages.sort((a, b) => (a.network !== b.network ? (a.network < b.network ? -1 : 1) : a.size_gb - b.size_gb))
    return ok(200, { packages })
  }
}
