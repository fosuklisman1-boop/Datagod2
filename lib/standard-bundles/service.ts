import type { HubtelCsTx } from "@/lib/hubtel-cs/types"
import type { PurchaseInput } from "@/lib/hubtel-cs/client"
import { HubtelDuplicateOrderError, HubtelOutcomeUnknownError } from "@/lib/hubtel-cs/errors"
import { ghanaSignificant, isValidGhanaMobile, validateNetworkPrefix, type NetworkPrefixMap } from "@/lib/phone-format"
import type { CatalogDeps } from "./catalog"
import { NETWORK_SERVICE, type BundleNetwork } from "./categories"
import type { BundlesConfig } from "./config"
import { verifyBundleToken } from "./token"
import type { CashbackConfig } from "@/lib/cashback/config"
import { quoteCashback, samePrice, type CashbackQuote } from "@/lib/cashback/quote"

export interface DataOrderRow {
  id: string; reference_code: string; user_id: string; channel: "dashboard"; network: BundleNetwork; service_key: string
  beneficiary_phone: string; bundle_value: string; bundle_display: string; bundle_category: string; amount: number
  status: "pending" | "processing" | "completed" | "failed" | "refunded"
  payment_status: "unpaid" | "paid" | "refunded"; idempotency_key: string; hubtel_client_reference: string | null
  commission: number | null; failure_reason: string | null; notes: string | null; created_at: string; updated_at: string
  /** Wallet charge when instant cashback applied (amount stays the face value Hubtel receives); null = amount. */
  paid_amount?: number | null
  cashback_amount?: number | null; shop_share_amount?: number | null; cashback_rate?: number | null
  cashback_share?: number | null; cashback_provider?: string | null; expected_commission?: number | null
}

export type NewDataOrder = Omit<DataOrderRow, "id" | "created_at" | "updated_at" | "hubtel_client_reference" | "commission" | "failure_reason" | "notes">

export interface BundlesDeps extends CatalogDeps {
  getCashbackConfig(): Promise<CashbackConfig>
  getBuyerTier(userId: string): Promise<"customer" | "dealer">
  purchase(input: PurchaseInput): Promise<HubtelCsTx>
  /** Admin-editable network prefix map + its on/off toggle (lib/network-prefix-config.ts). */
  getPrefixConfig(): Promise<{ enabled: boolean; map: NetworkPrefixMap }>
  findOrderByIdempotencyKey(userId: string, idempotencyKey: string): Promise<DataOrderRow | null>
  /** Throws with `code: "23505"` on a unique violation. */
  insertOrder(row: NewDataOrder): Promise<DataOrderRow>
  getOrder(id: string): Promise<DataOrderRow | null>
  /** Returns the number of rows updated; with `onlyFromStatuses` the write is guarded on the current status. */
  updateOrder(id: string, patch: Partial<DataOrderRow>, onlyFromStatuses?: DataOrderRow["status"][], onlyIfPaymentStatus?: DataOrderRow["payment_status"]): Promise<number>
  /** Atomic `data_order_debit` RPC: lock order, deduct wallet, mark paid, write history. Throws on RPC error (outcome unknown). */
  debitOrder(orderId: string): Promise<"ok" | "insufficient" | "not_found">
  /** `urgent` alerts keep the email fallback when SMS cannot be sent. */
  alert(message: string, urgent?: boolean): Promise<void>
  newReference(): string
}

/** `expectedPay`: the price the client was shown; a mismatch with the live quote => 409 before any write. */
export type BuyInput = { token: string; phone: string; idempotencyKey: string; expectedPay?: number }
export type PriceQuote = { faceAmount: number; payAmount: number; customerCashback: number }
export type BuyResult =
  | { ok: true; order: DataOrderRow }
  | { ok: false; status: number; error: string; order?: DataOrderRow; quote?: PriceQuote }

export const PRICE_UPDATED = "Price updated — please review"

const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{8,64}$/
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && IDEMPOTENCY_KEY.test(key)
}

/** Hubtel amounts are compared at 2 decimal places. */
export const sameAmount = (a: number, b: number): boolean =>
  Number.isFinite(a) && Number.isFinite(b) && Math.round(a * 100) === Math.round(b * 100)

export const NOT_AVAILABLE_FOR_NUMBER = "This bundle isn't available for that number right now — refresh"
/** Invalid or expired catalog token: same "reload and re-pick" situation as a changed bundle, so it is a 409. */
export const PRICES_REFRESHED = "Prices refreshed — pick the bundle again"
export const INSUFFICIENT = "Insufficient wallet balance"
const UNAVAILABLE = "Bundles unavailable right now"

const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })
const safeAlert = async (d: BundlesDeps, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* alerting must never break the flow */ } }
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function buyBundle(d: BundlesDeps, userId: string, input: BuyInput): Promise<BuyResult> {
  if (!isValidIdempotencyKey(input?.idempotencyKey)) return fail(400, "Invalid request, please try again")
  // Repeat submit (double-click / network retry) with the same key: never a second order, never a second debit.
  let existing: DataOrderRow | null
  try {
    existing = await d.findOrderByIdempotencyKey(userId, input.idempotencyKey)
  } catch {
    return fail(503, "Temporarily unavailable")
  }
  if (existing) return replayExisting(d, userId, existing)

  if (!d.secret) return fail(503, UNAVAILABLE)
  const v = verifyBundleToken(input.token, d.secret, d.now())
  if (!v) return fail(409, PRICES_REFRESHED)

  const phone = typeof input.phone === "string" ? input.phone : ""
  if (!isValidGhanaMobile(phone)) return fail(400, "Enter a valid Ghana mobile number")
  let prefix: { enabled: boolean; map: NetworkPrefixMap } | null = null
  try { prefix = await d.getPrefixConfig() } catch { prefix = null }
  // A failed read validates with the defaults (the safe direction), matching getPrefixValidationConfig.
  if (!prefix || prefix.enabled !== false) {
    const check = validateNetworkPrefix(v.network, phone, prefix?.map)
    if (!check.ok) return fail(400, check.message)
  }
  const phone233 = "233" + ghanaSignificant(phone)!

  // Every pre-debit check happens before the first write.
  let cfg: BundlesConfig
  try { cfg = await d.getBundlesConfig() } catch { return fail(503, UNAVAILABLE) }
  const net = cfg.networks?.[v.network]
  if (!cfg.enabled || !net?.enabled) return fail(403, "Standard Bundles are not available")
  if ((net.hiddenCategories ?? []).includes(v.category)) return fail(403, "This bundle is not available")
  const serviceKey = NETWORK_SERVICE[v.network]
  try {
    const h = await d.getHubtelConfig()
    if (!h.enabled || h.services?.[serviceKey] !== true || h.paused) return fail(503, UNAVAILABLE)
  } catch {
    return fail(503, UNAVAILABLE)
  }

  // Re-query for the buyer's own number: the exact (Value, Amount) must still be offered.
  let res: Awaited<ReturnType<BundlesDeps["query"]>>
  try { res = await d.query(serviceKey, phone233) } catch (e) {
    console.error("[bundles] re-query threw:", msg(e))
    return fail(503, UNAVAILABLE)
  }
  if (!res.ok) return fail(503, UNAVAILABLE)
  const offered = (res.data ?? []).some(it => it?.Value === v.value && sameAmount(Number(it?.Amount), v.amount))
  if (!offered) return fail(409, NOT_AVAILABLE_FOR_NUMBER)

  const amount = Math.round(v.amount * 100) / 100
  // Face value (the Hubtel price) goes to Hubtel; the wallet is charged face − cashback when cashback applies.
  const q = await quoteBundle(d, userId, serviceKey, amount)
  if (input.expectedPay !== undefined && !samePrice(input.expectedPay, q.payAmount)) {
    return {
      ok: false, status: 409, error: PRICE_UPDATED,
      quote: { faceAmount: q.faceAmount, payAmount: q.payAmount, customerCashback: q.customerCashback },
    }
  }
  let order: DataOrderRow
  try {
    order = await d.insertOrder({
      reference_code: d.newReference(), user_id: userId, channel: "dashboard", network: v.network, service_key: serviceKey,
      beneficiary_phone: phone233, bundle_value: v.value, bundle_display: v.display, bundle_category: v.category,
      amount, status: "pending", payment_status: "unpaid", idempotency_key: input.idempotencyKey,
      paid_amount: q.applied ? q.payAmount : null,
      ...(q.applied
        ? {
            cashback_amount: q.customerCashback, shop_share_amount: q.shopShare, cashback_rate: q.rate,
            cashback_share: q.share, cashback_provider: q.provider, expected_commission: q.commission,
          }
        : {}),
    })
  } catch (e: any) {
    if (e?.code === "23505") {
      // A concurrent request with the same key won the insert: hand back its order.
      let existing: DataOrderRow | null = null
      try { existing = await d.findOrderByIdempotencyKey(userId, input.idempotencyKey) } catch { existing = null }
      if (existing) return { ok: true, order: existing }
    }
    // Nothing was debited (the debit needs the inserted row), so this is a retryable pre-payment failure. A retry with the
    // same key finds the row if the insert did commit, and resumes it.
    return fail(503, "Could not create the order. You were not charged — please try again.")
  }

  return debitAndDispatch(d, userId, order)
}

/**
 * Instant-cashback quote for a dashboard bundle purchase. Any config or tier read failure => not applied (standard
 * price), never a blocked purchase.
 */
async function quoteBundle(d: BundlesDeps, userId: string, serviceKey: string, face: number): Promise<CashbackQuote> {
  const none: CashbackQuote = {
    applied: false, faceAmount: face, rate: 0, share: 0, commission: 0, customerCashback: 0, shopShare: 0,
    payAmount: face, datagodKeeps: 0, provider: "hubtel",
  }
  try {
    const cfg = await d.getCashbackConfig()
    if (!cfg.enabled || !cfg.surfaces.dashboard) return none
    const buyer = await d.getBuyerTier(userId)
    return quoteCashback({ serviceKey, provider: "hubtel", faceAmount: face, buyer, channel: "dashboard" }, cfg)
  } catch (e) {
    console.warn("[bundles] cashback quote unavailable, using standard pricing:", msg(e))
    return none
  }
}

/**
 * Same idempotency key as an earlier request.
 * - pending + unpaid: the earlier debit never happened (or rolled back), so RESUME it through the normal debit path.
 *   `data_order_debit` only acts on pending+unpaid rows, so a concurrent resume cannot debit twice.
 * - failed + unpaid: never charged (insufficient balance) - say so, so the client rotates the key.
 * - anything paid: hand back the order as it is.
 */
async function replayExisting(d: BundlesDeps, userId: string, existing: DataOrderRow): Promise<BuyResult> {
  if (existing.payment_status === "unpaid" && existing.status === "failed") {
    return { ok: false, status: 402, error: INSUFFICIENT, order: existing }
  }
  if (existing.payment_status !== "unpaid" || existing.status !== "pending") return { ok: true, order: existing }
  // Resume: re-check the switches that would have stopped a fresh buy before the debit (the token/price checks were
  // done when the order was created). Refused => 503, the order stays "not charged" and the key stays usable.
  try {
    const cfg = await d.getBundlesConfig()
    const net = cfg.networks?.[existing.network]
    if (!cfg.enabled || !net?.enabled) return fail(503, UNAVAILABLE)
    const h = await d.getHubtelConfig()
    if (!h.enabled || h.services?.[NETWORK_SERVICE[existing.network]] !== true || h.paused) return fail(503, UNAVAILABLE)
  } catch {
    return fail(503, UNAVAILABLE)
  }
  return debitAndDispatch(d, userId, existing)
}

/** Debit a pending+unpaid order, then claim and dispatch it. Shared by a fresh buy and a resumed replay. */
async function debitAndDispatch(d: BundlesDeps, userId: string, order: DataOrderRow): Promise<BuyResult> {
  const amount = order.paid_amount ?? order.amount // what data_order_debit deducts
  let debit: "ok" | "insufficient" | "not_found" | null = null
  try {
    debit = await d.debitOrder(order.id)
  } catch {
    // Outcome unknown: believe only the database.
    let fresh: DataOrderRow | null = null
    try { fresh = await d.getOrder(order.id) } catch { fresh = null }
    if (fresh && fresh.payment_status === "paid") {
      debit = "ok"
    } else {
      await safeAlert(d, `Standard bundle debit outcome uncertain: order ${order.reference_code}, user ${userId}, GHS ${amount} — check wallet`, true)
      return { ok: false, status: 500, error: "We could not confirm your payment. Please check your wallet before retrying.", order }
    }
  }
  if (debit === "not_found") {
    // The row is no longer pending+unpaid: typically a concurrent request with the same key paid it first.
    let fresh: DataOrderRow | null = null
    try { fresh = await d.getOrder(order.id) } catch { fresh = null }
    if (fresh && fresh.payment_status !== "unpaid") return { ok: true, order: fresh }
    if (fresh && fresh.status === "failed") return { ok: false, status: 402, error: INSUFFICIENT, order: fresh }
    return { ok: false, status: 409, error: "This order can no longer be paid", order: fresh ?? order }
  }
  if (debit === "insufficient") {
    const patch = { status: "failed" as const, failure_reason: INSUFFICIENT }
    // Only an order that is still unpaid: a concurrent resume may have paid it after a top-up.
    await d.updateOrder(order.id, patch, ["pending"], "unpaid").catch(() => 0)
    return { ok: false, status: 402, error: INSUFFICIENT, order: { ...order, ...patch } }
  }
  order = { ...order, payment_status: "paid" }
  const r = await dispatchInternal(d, order)
  return { ok: true, order: { ...order, ...r.patch, status: r.status } }
}

const DISPATCHING = "Dispatching…"

async function dispatchInternal(d: BundlesDeps, order: DataOrderRow): Promise<{ status: DataOrderRow["status"]; patch: Partial<DataOrderRow> }> {
  if (order.status !== "pending" || order.payment_status !== "paid") return { status: order.status, patch: {} }
  const ref = order.reference_code
  try {
    const fresh = await d.getOrder(order.id)
    if (!fresh || fresh.status !== "pending" || fresh.payment_status !== "paid") return { status: fresh?.status ?? order.status, patch: {} }
    order = fresh
  } catch (e) {
    await safeAlert(d, `Standard bundle order ${ref}: could not re-read the order before dispatch (${msg(e)}). It was paid and not sent; check it in Standard Bundles.`)
    return { status: order.status, patch: {} }
  }
  const guarded = async (patch: Partial<DataOrderRow>, from: DataOrderRow["status"][]) => {
    try { return await d.updateOrder(order.id, patch, from) } catch { return 0 }
  }
  let claimed = false
  try {
    const input: PurchaseInput = {
      serviceKey: NETWORK_SERVICE[order.network], destination: order.beneficiary_phone, amount: order.amount,
      bundle: order.bundle_value /* exact, never trimmed */, orderTable: "hubtel_data_orders", orderId: order.id,
    }
    // Atomic claim BEFORE purchase: whoever flips pending -> processing owns the send. A concurrent dispatch or an
    // admin refund (which needs status pending) loses here instead of racing the Hubtel call.
    const claimPatch: Partial<DataOrderRow> = { status: "processing", notes: DISPATCHING }
    if ((await guarded(claimPatch, ["pending"])) === 0) return { status: order.status, patch: {} }
    claimed = true

    let tx: HubtelCsTx
    try {
      tx = await d.purchase(input)
    } catch (e) {
      if (e instanceof HubtelDuplicateOrderError) {
        const patch: Partial<DataOrderRow> = { notes: "A live Hubtel transaction already exists for this order; do not resend." }
        await guarded(patch, ["processing"])
        await safeAlert(d, `Standard bundle order ${ref}: a live Hubtel transaction exists but the order has no reference — check the Hubtel review queue; do not resend.`)
        return { status: "processing", patch }
      }
      if (e instanceof HubtelOutcomeUnknownError) {
        const patch: Partial<DataOrderRow> = {
          hubtel_client_reference: e.clientReference,
          notes: `Outcome unknown, do not resend. Hubtel ref ${e.clientReference}`,
        }
        const n = await guarded(patch, ["processing"])
        await safeAlert(d, `Standard bundle order ${ref}: Hubtel outcome unknown (ref ${e.clientReference}), do not resend.${n === 0 ? " The order record could not be updated." : ""}`)
        return { status: "processing", patch: n === 0 ? {} : patch }
      }
      // Raised before the POST: nothing was sent. Release the claim back to pending for an admin.
      const patch: Partial<DataOrderRow> = { status: "pending", notes: `Not sent: ${msg(e)}` }
      const n = await guarded(patch, ["processing"])
      if (n === 0) return { status: order.status, patch: {} }
      await safeAlert(d, `Standard bundle order ${ref} was paid but NOT sent to Hubtel: ${msg(e)}`)
      return { status: "pending", patch }
    }
    if (tx.state === "fulfilled") return { status: "completed", patch: {} }
    if (tx.state === "failed") return { status: "failed", patch: {} }
    const patch: Partial<DataOrderRow> = { hubtel_client_reference: tx.client_reference, notes: null }
    if (tx.state === "needs_review") {
      patch.notes = `Outcome unknown, do not resend. Hubtel ref ${tx.client_reference}`
      await safeAlert(d, `Standard bundle order ${ref}: Hubtel outcome unknown (ref ${tx.client_reference}), do not resend.`)
    }
    const n = await guarded(patch, ["processing"])
    if (n === 0) {
      // A fast callback may already have settled the order: believe the database, not the failed write.
      let cur: DataOrderRow | null = null
      try { cur = await d.getOrder(order.id) } catch { cur = null }
      if (cur && !(cur.status === "processing" && !cur.hubtel_client_reference)) return { status: cur.status, patch: {} }
      await safeAlert(d, `Standard bundle order ${ref}: Hubtel has the transaction (ref ${tx.client_reference}) but the order could not be updated. Reconcile manually; do not resend.`)
      return { status: cur?.status ?? order.status, patch: {} }
    }
    return { status: "processing", patch }
  } catch (e) {
    await safeAlert(d, `Standard bundle order ${ref}: dispatch error ${msg(e)}${claimed ? " (order left processing; reconcile manually)" : ""}`)
    return { status: claimed ? "processing" : order.status, patch: {} }
  }
}
