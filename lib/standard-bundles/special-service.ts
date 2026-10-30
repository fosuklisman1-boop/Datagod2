import { samePrice } from "@/lib/cashback/quote"
import { SPECIAL_MAX_MULTIPLE, type BundlesConfig } from "./config"
import {
  dispatchBundleOrder, INSUFFICIENT, isValidIdempotencyKey, prepareBundlePurchase, PRICES_REFRESHED, quoteBundle,
  type BundlesDeps, type BuyInput, type DataOrderRow, type PriceQuote,
} from "./service"
import { formatSpecialGb, parseBundleMb } from "./special"
import { verifySpecialToken } from "./token"

/**
 * Special Bundles buy (MTN, dashboard wallet only): N x the unit bundle for one recipient, ONE wallet debit and N
 * ordinary child orders created atomically by the `create_special_bundle_orders` RPC (migration 0141), then each
 * child dispatched through the normal dispatchBundleOrder, one after another, after the response.
 */

/** A hubtel_data_orders row with the 0141 group columns (null on every non-Special row). */
export type SpecialChildRow = DataOrderRow & { special_group_id?: string | null; special_index?: number | null }

/** One unit object of p_rows: exactly the keys the RPC accepts. */
export interface SpecialUnitRow {
  network: "MTN"; service_key: string; beneficiary_phone: string
  bundle_value: string; bundle_display: string; bundle_category: string
  amount: number; paid_amount: number
  cashback_amount?: number; shop_share_amount?: number; cashback_rate?: number; cashback_share?: number
  cashback_provider?: string; expected_commission?: number
}

export interface SpecialRpcArgs { userId: string; groupKey: string; n: number; rows: SpecialUnitRow[]; total: number }
export type SpecialRpcResult =
  | { ok: true; groupId: string; orderIds: string[]; replay: boolean }
  | { ok: false; error: "insufficient" | "bad_input"; detail?: string }

export interface SpecialDeps extends BundlesDeps {
  /** create_special_bundle_orders. Maps INSUFFICIENT_FUNDS / BAD_INPUT; THROWS on anything else (outcome unknown). */
  createSpecialOrders(a: SpecialRpcArgs): Promise<SpecialRpcResult>
  /** The user's children of one group, ordered by special_index. */
  listSpecialGroup(userId: string, groupId: string): Promise<SpecialChildRow[]>
  /** next/server `after()`: runs the task after the response is sent. */
  schedule(task: () => Promise<void>): void
}

export type SpecialBuyResult =
  | { ok: true; order: DataOrderRow; special: { groupId: string; n: number }; replay: boolean }
  | { ok: false; status: number; error: string; quote?: PriceQuote }

export const SPECIAL_PRICE_CHANGED = "Price changed. Please try again."
const UNAVAILABLE = "Bundles unavailable right now"
/** The sequential dispatch loop stops starting new children after this long (the route allows 300s). */
export const DISPATCH_BUDGET_MS = 240_000
const KEY_USED ="This request was already used for another purchase. Please try again."

const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })
const cents = (n: number) => Math.round(n * 100)
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const safeAlert = async (d: SpecialDeps, m: string, urgent = false) => { try { await d.alert(m, urgent) } catch { /* never break the flow */ } }

/** The same config, with MTN's hidden categories cleared: Special is governed by its own switch only (ruling). */
function ignoreHidden(cfg: BundlesConfig): BundlesConfig {
  const mtn = cfg.networks?.MTN
  return mtn ? { ...cfg, networks: { ...cfg.networks, MTN: { ...mtn, hiddenCategories: [] } } } : cfg
}

export async function buySpecial(d: SpecialDeps, userId: string, input: BuyInput): Promise<SpecialBuyResult> {
  // 1. Key, channel (dashboard only), user; then the replay, before any token or config check.
  if (!isValidIdempotencyKey(input?.idempotencyKey)) return fail(400, "Invalid request, please try again")
  if (input.channel !== undefined && input.channel !== "dashboard") return fail(400, "Invalid request, please try again")
  if (typeof userId !== "string" || !userId) return fail(401, "Unauthorized")
  const key = input.idempotencyKey
  try {
    const first = (await d.findOrderByIdempotencyKey(userId, `${key}:1`)) as SpecialChildRow | null
    if (first) {
      if (!first.special_group_id) return fail(409, KEY_USED)
      return await replayGroup(d, userId, first.special_group_id, first)
    }
    // A normal order already holds this exact key: one key = one purchase.
    if (await d.findOrderByIdempotencyKey(userId, key)) return fail(409, KEY_USED)
  } catch {
    return fail(503, "Temporarily unavailable")
  }

  // 2. The special token (and, inside it, the unit token through verifyBundleToken, the normal buy's verifier).
  if (!d.secret) return fail(503, UNAVAILABLE)
  const s = verifySpecialToken(input.token, d.secret, d.now())
  if (!s) return fail(409, PRICES_REFRESHED)

  // 3. Live config: the token encodes none of it.
  let cfg: BundlesConfig
  try { cfg = await d.getBundlesConfig() } catch { return fail(503, UNAVAILABLE) }
  const sp = cfg.special
  if (!sp?.enabled || s.unit.network !== "MTN") return fail(403, "Special Bundles are not available")
  if (s.n > SPECIAL_MAX_MULTIPLE || !sp.multiples.includes(s.n)) return fail(409, PRICES_REFRESHED)
  // 4. The unit is still the configured one (value exact, amount to the cent).
  if (s.unit.value !== sp.unitValue || cents(s.unit.amount) !== cents(sp.unitAmount)) return fail(409, PRICES_REFRESHED)

  // 5 + 7. The normal buy's pre-write checks on the unit, minus the hidden-category refusal: recipient + prefix rules,
  // bundles/MTN switches, Hubtel on + data_mtn on + not paused, and a live re-query for the recipient that must still
  // offer the exact (value, amount). Same config snapshot as the checks above.
  const prep = await prepareBundlePurchase({ ...d, getBundlesConfig: async () => ignoreHidden(cfg) }, s.unit, input.phone)
  if (!prep.ok) return prep

  // 6. Per-unit price with quoteBundle (dashboard channel, buyer tier), cashback floored per unit; total = n x unit pay.
  const q = await quoteBundle(d, userId, prep.serviceKey, prep.amount, "dashboard")
  const unitPayC = cents(q.payAmount)
  const cashC = q.applied ? cents(q.customerCashback) : 0
  if (unitPayC <= 0 || unitPayC !== cents(prep.amount) - cashC) return fail(503, UNAVAILABLE)
  const n = s.n
  const total = (unitPayC * n) / 100
  if (input.expectedPay === undefined || !samePrice(input.expectedPay, total)) {
    return {
      ok: false, status: 409, error: SPECIAL_PRICE_CHANGED,
      quote: { faceAmount: (cents(prep.amount) * n) / 100, payAmount: total, customerCashback: (cashC * n) / 100 },
    }
  }

  const unit: SpecialUnitRow = {
    network: "MTN", service_key: prep.serviceKey, beneficiary_phone: prep.phone233,
    bundle_value: s.unit.value, bundle_display: s.unit.display, bundle_category: s.unit.category,
    amount: prep.amount, paid_amount: unitPayC / 100,
    ...(q.applied
      ? {
          cashback_amount: cashC / 100, shop_share_amount: q.shopShare, cashback_rate: q.rate, cashback_share: q.share,
          cashback_provider: q.provider, expected_commission: q.commission,
        }
      : {}),
  }
  const rows = Array.from({ length: n }, () => ({ ...unit }))

  let r: SpecialRpcResult
  try {
    r = await d.createSpecialOrders({ userId, groupKey: key, n, rows, total })
  } catch (e) {
    console.error("[bundles] special RPC error (outcome unknown):", msg(e))
    // Outcome unknown: believe only the database.
    let first: SpecialChildRow | null = null
    try { first = (await d.findOrderByIdempotencyKey(userId, `${key}:1`)) as SpecialChildRow | null } catch { first = null }
    if (first?.special_group_id) return committed(d, userId, first.special_group_id, n, null)
    await safeAlert(d, `Special bundle purchase outcome uncertain: user ${userId}, ${n} x ${s.unit.display}, GHS ${total} — check wallet`, true)
    return fail(500, "We could not confirm your payment. Please check your wallet before retrying.")
  }
  if (!r.ok) {
    if (r.error === "insufficient") return fail(402, INSUFFICIENT)
    console.error("[bundles] special RPC refused input:", r.detail ?? "")
    return fail(400, "Could not place this order. You were not charged — please try again.")
  }
  // Lost a same-key race inside the RPC: the earlier call owns the group and its dispatch.
  if (r.replay) return replayGroup(d, userId, r.groupId, null)
  return committed(d, userId, r.groupId, n, r.orderIds)
}

/** The group is paid: schedule its children's dispatch, then answer with the group summary. */
async function committed(d: SpecialDeps, userId: string, groupId: string, n: number, orderIds: string[] | null): Promise<SpecialBuyResult> {
  let children: SpecialChildRow[] = []
  try { children = await d.listSpecialGroup(userId, groupId) } catch (e) {
    console.error("[bundles] special group read failed:", msg(e))
  }
  const ids = orderIds ?? children.map(c => c.id)
  scheduleDispatch(d, groupId, ids)
  if (children.length === 0) {
    // Paid and scheduled; only the summary read failed. Never report a paid purchase as an error.
    return { ok: true, replay: false, special: { groupId, n: ids.length || n }, order: placeholder(groupId) }
  }
  return { ok: true, replay: false, special: { groupId, n: children.length }, order: summarize(groupId, children) }
}

/** The EARLIER group's purchase as it stands (its n, phone, status), never the new selection. Not re-dispatched. */
async function replayGroup(d: SpecialDeps, userId: string, groupId: string, first: SpecialChildRow | null): Promise<SpecialBuyResult> {
  let children: SpecialChildRow[]
  try { children = await d.listSpecialGroup(userId, groupId) } catch { return fail(503, "Temporarily unavailable") }
  if (children.length === 0 && first) children = [first]
  if (children.length === 0) return fail(503, "Temporarily unavailable")
  return { ok: true, replay: true, special: { groupId, n: children.length }, order: summarize(groupId, children) }
}

function scheduleDispatch(d: SpecialDeps, groupId: string, ids: string[]): void {
  const task = async () => {
    const start = d.now()
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      // Time budget (route maxDuration 300s): past 240s, stop and hand the rest to an admin, never a silent cut-off.
      if (d.now() - start > DISPATCH_BUDGET_MS) {
        const k = ids.length - i
        console.error("[bundles] special dispatch time budget exceeded:", groupId, `${k}/${ids.length} not sent`)
        await safeAlert(d, `Special group ${groupId}: ${k} of ${ids.length} units not sent (time budget); retry them from /admin/standard-bundles`, true)
        return
      }
      // One child failing never stops the others; every failure leaves a log line and an admin alert.
      try {
        const row = await d.getOrder(id)
        if (!row) {
          console.error("[bundles] special child missing:", id)
          await safeAlert(d, `Special bundle group ${groupId}: child order ${id} not found for dispatch. Check it in Standard Bundles.`)
          continue
        }
        await dispatchBundleOrder(d, row)
      } catch (e) {
        console.error("[bundles] special child dispatch error:", id, msg(e))
        await safeAlert(d, `Special bundle group ${groupId}: child order ${id} dispatch error (${msg(e)}). It is paid; check it in Standard Bundles.`)
      }
    }
  }
  try {
    d.schedule(task)
  } catch (e) {
    console.error("[bundles] special dispatch could not be scheduled:", msg(e))
    void safeAlert(d, `Special bundle group ${groupId}: PAID but dispatch could not be scheduled (${ids.length} children left pending). Dispatch them from Standard Bundles.`, true)
  }
}

/** One status for the group: every child agrees => that status; otherwise processing (admin review). */
function summarize(groupId: string, children: SpecialChildRow[]): DataOrderRow {
  const rows = [...children].sort((a, b) => (a.special_index ?? 0) - (b.special_index ?? 0))
  const first = rows[0]
  const sum = (f: (c: SpecialChildRow) => number) => rows.reduce((acc, c) => acc + cents(f(c)), 0) / 100
  const statuses = new Set(rows.map(c => c.status))
  const payments = new Set(rows.map(c => c.payment_status))
  const mb = parseBundleMb(first.bundle_display, first.bundle_value)
  return {
    ...first,
    id: groupId,
    amount: sum(c => Number(c.amount)),
    paid_amount: sum(c => Number(c.paid_amount ?? c.amount)),
    cashback_amount: sum(c => Number(c.cashback_amount ?? 0)),
    status: statuses.size === 1 ? first.status : "processing",
    payment_status: payments.size === 1 ? first.payment_status : "paid",
    bundle_display: mb === null ? `${rows.length} x ${first.bundle_display}` : formatSpecialGb(mb * rows.length),
  }
}

function placeholder(groupId: string): DataOrderRow {
  return {
    id: groupId, reference_code: "", user_id: "", channel: "dashboard", network: "MTN", service_key: "data_mtn",
    beneficiary_phone: "", bundle_value: "", bundle_display: "", bundle_category: "", amount: 0, status: "pending",
    payment_status: "paid", idempotency_key: "", hubtel_client_reference: null, commission: null, failure_reason: null,
    notes: null, created_at: "", updated_at: "",
  }
}
