import { toPesewas } from "@/lib/cashback/quote"
import { SPECIAL_MAX_MULTIPLE, type BundlesConfig } from "@/lib/standard-bundles/config"
import { getCatalog, peekCatalogBundles } from "@/lib/standard-bundles/catalog"
import { isValidIdempotencyKey, prepareBundlePurchase, PRICES_REFRESHED } from "@/lib/standard-bundles/service"
import { ignoreHidden } from "@/lib/standard-bundles/special-service"
import { buildSpecialEntries, findSpecialUnit } from "@/lib/standard-bundles/special"
import { verifySpecialToken } from "@/lib/standard-bundles/token"
import type { PriceQuote } from "@/lib/storefront-commission/bills"
import { fail, parseExpectedPay, priceMatches, NOT_AVAILABLE, PRICE_UPDATED, UNAVAILABLE, type Fail } from "@/lib/storefront-commission/shop"
import { botBundlesCfg } from "./catalog"
import { checkBotPendingCaps } from "./caps"
import { resolveBotContext, type BotContext, type BotSurface, type ResolvedBotContext } from "./context"
import { quoteFor, snapshot, type BotBundlesDeps } from "./orders"

/**
 * Special Bundles on the bots (Hubtel USSD only): N x the unit bundle for one recipient, priced PER UNIT, created as ONE
 * group of N unpaid child rows by the `create_bot_special_bundle_orders` RPC (migration 0158). No money moves here: the
 * buyer pays one Hubtel checkout after the rows exist (the USSD flow, not this file).
 */

/** The only bot that sells Special Bundles. */
const SPECIAL_SURFACE: BotSurface = "hubtel_ussd"
const KEY_USED = "This request was already used for another purchase. Please try again."

/** One unit object of p_rows (identical N times): exactly the keys the RPC accepts. */
export interface BotSpecialUnitRow {
  network: "MTN"; service_key: string; beneficiary_phone: string
  bundle_value: string; bundle_display: string; bundle_category: string
  amount: number
  /** The buyer's price per unit: amount - cashback_amount + payment_fee_amount, exactly. */
  paid_amount: number
  payment_fee_amount: number
  cashback_amount: number | null; shop_share_amount: number | null; cashback_rate: number | null
  cashback_share: number | null; cashback_provider: string | null; expected_commission: number | null
}

export interface BotSpecialRpcArgs {
  surface: BotSurface; buyer: string; shop: string | null; groupKey: string; n: number
  rows: BotSpecialUnitRow[]
  /** N x paid_amount: the amount of the one checkout that follows. */
  total: number
}
export type BotSpecialRpcResult =
  | { ok: true; groupId: string; orderIds: string[]; replay: boolean }
  /**
   * bad_input = BAD_INPUT (nothing written); conflict = GROUP_CONFLICT (a unique clash that was not a replay);
   * unavailable = the function does not exist (migration 0158 not applied).
   */
  | { ok: false; error: "bad_input" | "conflict" | "unavailable" }

/** The columns the engine reads back from a group's child rows. */
export interface BotSpecialChild { id: string; special_group_id: string; special_index: number; paid_amount: number | null }

export interface BotSpecialDeps extends BotBundlesDeps {
  /** create_bot_special_bundle_orders. Maps BAD_INPUT / GROUP_CONFLICT / function-not-found; THROWS on anything else (outcome unknown). */
  createBotSpecialOrders(a: BotSpecialRpcArgs): Promise<BotSpecialRpcResult>
  /** This buyer's children of the group whose child 1 holds `<key>:1`, ordered by special_index. [] when there is none. Throws on read error. */
  listBotSpecialGroup(botSurface: BotSurface, buyerPhone: string, key: string): Promise<BotSpecialChild[]>
}

export interface BotSpecialPlan { token: string; display: string; n: number; faceAmount: number; payAmount: number }
export interface BotSpecialOrder { id: string; groupId: string; n: number; payAmount: number }
export type BotSpecialOrderResult = { ok: true; order: BotSpecialOrder } | (Fail & { quote?: PriceQuote })

export interface BotSpecialOrderInput { token: unknown; recipient: unknown; idempotencyKey: unknown; expectedPay: unknown }

/** The RPC reports errors by message; PostgREST adds `code`. Never read or keep the rest of the error (its text can carry a phone). */
interface RpcError { message?: string; code?: string }

/** Pure mapping of a `.rpc()` answer. Anything that is not a documented outcome THROWS, with no database text in it. */
export function mapBotSpecialRpc(data: unknown, error: RpcError | null | undefined): BotSpecialRpcResult {
  if (error) {
    if (error.message === "BAD_INPUT") return { ok: false, error: "bad_input" }
    if (error.message === "GROUP_CONFLICT") return { ok: false, error: "conflict" }
    if (error.code === "PGRST202" || error.code === "42883") return { ok: false, error: "unavailable" }
    throw new Error(`bot special rpc failed (code ${String(error.code ?? "unknown")})`)
  }
  const r = data as { group_id?: unknown; order_ids?: unknown; replay?: unknown } | null
  if (!r || typeof r.group_id !== "string" || !Array.isArray(r.order_ids) || !r.order_ids.every(i => typeof i === "string") || typeof r.replay !== "boolean") {
    throw new Error("bot special rpc returned an unexpected shape")
  }
  return { ok: true, groupId: r.group_id, orderIds: r.order_ids as string[], replay: r.replay }
}

const cents = toPesewas

/**
 * The Special plans this bot may show: [] unless Special, its USSD switch, the bots bundles gate and the unit in the
 * live catalog are all in place and Hubtel is not paused. Each plan's price is N x the per-unit bot quote (never the
 * quote of the total). Config read failures are a 503, never an empty list.
 */
export async function botSpecialPlans(d: BotSpecialDeps, ctx: BotContext): Promise<{ ok: true; plans: BotSpecialPlan[] } | Fail> {
  const r = resolveBotContext(ctx)
  if (!r.ok) return r
  const c = r.ctx
  const none = { ok: true as const, plans: [] as BotSpecialPlan[] }
  if (c.botSurface !== SPECIAL_SURFACE) return none
  if (!d.secret) return fail(503, UNAVAILABLE)

  // One config snapshot for the whole call.
  let snap: Promise<BundlesConfig> | null = null
  const once: BotSpecialDeps = { ...d, getBundlesConfig: () => (snap ??= d.getBundlesConfig()) }
  let bcfg: BundlesConfig
  try { bcfg = await once.getBundlesConfig() } catch { return fail(503, UNAVAILABLE) }
  const sp = bcfg.special
  if (!sp?.enabled || !sp.ussdEnabled) return none

  const g = await botBundlesCfg(d)
  if (!g.ok) return g.status === 403 ? none : g
  try {
    const h = await d.getHubtelConfig()
    if (h?.paused) return none
  } catch { return fail(503, UNAVAILABLE) }

  const cat = await getCatalog(once, "MTN")
  if (!cat.ok) return cat.status === 403 ? none : fail(503, UNAVAILABLE)
  const unit = findSpecialUnit(peekCatalogBundles("MTN") ?? [], sp.unitAmount, sp.unitValue)
  if (!unit) return none

  const q = quoteFor(c, "data_mtn", unit.bundle.amount, g.cfg)
  const unitPayC = cents(q.payAmount)
  if (unitPayC <= 0) return fail(503, UNAVAILABLE)
  const plans = buildSpecialEntries(unit, sp.multiples, d.secret, d.now()).map(e => ({
    token: e.token, display: e.display, n: e.special.n, faceAmount: e.amount, payAmount: (unitPayC * e.special.n) / 100,
  }))
  return { ok: true, plans }
}

/** Child 1's id for this buyer and key, or null. Throws on a read error (the caller must not guess). */
export async function findSpecialFirstChild(d: Pick<BotSpecialDeps, "findBotBundleOrder">, ctx: BotContext, key: string): Promise<string | null> {
  const r = resolveBotContext(ctx)
  if (!r.ok) return null
  const row = await d.findBotBundleOrder(r.ctx.botSurface, r.ctx.buyerPhone, `${key}:1`)
  return row?.id ?? null
}

/**
 * The group as the database holds it: n = child count, payAmount = the sum of the children's stored paid_amount in
 * pesewas, id = child 1. Never computed from the current request, so a replay can never quote a new price.
 */
async function readGroup(d: BotSpecialDeps, c: ResolvedBotContext, key: string): Promise<BotSpecialOrderResult> {
  let kids: BotSpecialChild[]
  try { kids = await d.listBotSpecialGroup(c.botSurface, c.buyerPhone, key) } catch { return fail(503, UNAVAILABLE) }
  if (kids.length === 0) return fail(503, UNAVAILABLE)
  const sorted = [...kids].sort((a, b) => a.special_index - b.special_index)
  let sumC = 0
  for (const k of sorted) {
    const p = Number(k.paid_amount)
    if (!Number.isFinite(p) || p <= 0) return fail(503, UNAVAILABLE)
    sumC += cents(p)
  }
  return { ok: true, order: { id: sorted[0].id, groupId: sorted[0].special_group_id, n: sorted.length, payAmount: sumC / 100 } }
}

/**
 * Create an UNPAID Special group (channel 'bots', surface hubtel_ussd only). A repeat with the same key hands back the
 * group already created, at its stored price, before any gate or cap. Every check runs before the single RPC; an
 * expectedPay mismatch => 409 with the live quote, nothing written. Any RPC error that is not a documented outcome
 * throws (the group may have committed): the caller finds it with findSpecialFirstChild.
 */
export async function botCreateSpecialOrder(d: BotSpecialDeps, ctx: BotContext, input: BotSpecialOrderInput): Promise<BotSpecialOrderResult> {
  const r = resolveBotContext(ctx)
  if (!r.ok) return r
  const c = r.ctx
  if (c.botSurface !== SPECIAL_SURFACE) return fail(403, NOT_AVAILABLE)
  if (!isValidIdempotencyKey(input?.idempotencyKey)) return fail(400, "Invalid request, please try again")
  const key = input.idempotencyKey

  // The repeat comes first: before any token, gate or cap (it never consumes a cap slot).
  let hasGroup = false
  try {
    if (await d.findBotBundleOrder(c.botSurface, c.buyerPhone, `${key}:1`)) hasGroup = true
    // A normal bot order already holds this exact key: one key = one purchase.
    else if (await d.findBotBundleOrder(c.botSurface, c.buyerPhone, key)) return fail(409, KEY_USED)
  } catch { return fail(503, UNAVAILABLE) }
  if (hasGroup) return readGroup(d, c, key)

  const expectedPay = parseExpectedPay(input.expectedPay)
  if (expectedPay === undefined) return fail(400, "expectedPay is required")
  if (!d.secret) return fail(503, UNAVAILABLE)
  const s = verifySpecialToken(typeof input.token === "string" ? input.token : "", d.secret, d.now())
  if (!s) return fail(409, PRICES_REFRESHED)

  const g = await botBundlesCfg(d)
  if (!g.ok) return g
  let bcfg: BundlesConfig
  try { bcfg = await d.getBundlesConfig() } catch { return fail(503, UNAVAILABLE) }
  const sp = bcfg.special
  if (!sp?.enabled || !sp.ussdEnabled || s.unit.network !== "MTN") return fail(403, NOT_AVAILABLE)
  if (s.n > SPECIAL_MAX_MULTIPLE || !sp.multiples.includes(s.n)) return fail(409, PRICES_REFRESHED)
  // The unit is still the configured one (value exact, amount to the cent).
  if (s.unit.value !== sp.unitValue || cents(s.unit.amount) !== cents(sp.unitAmount)) return fail(409, PRICES_REFRESHED)

  // Recipient + prefix, bundles/MTN switches, Hubtel up, live re-query for the recipient. Special is governed by its own
  // switch, so MTN's hidden categories are ignored (as on the dashboard). Same config snapshot as above.
  const prep = await prepareBundlePurchase({ ...d, getBundlesConfig: async () => ignoreHidden(bcfg) }, s.unit, input.recipient)
  if (!prep.ok) return prep.status === 403 ? fail(403, NOT_AVAILABLE) : prep

  // Per-unit price in integer pesewas; the group total is n x that, never a quote of the total.
  const q = quoteFor(c, prep.serviceKey, prep.amount, g.cfg)
  const faceC = cents(prep.amount)
  const cashC = q.applied ? cents(q.customerCashback) : 0
  const feeC = cents(q.paymentFee)
  const unitPayC = cents(q.payAmount)
  if (unitPayC <= 0 || unitPayC !== faceC - cashC + feeC) return fail(503, UNAVAILABLE)
  const n = s.n
  const total = (unitPayC * n) / 100
  if (!priceMatches(expectedPay, total)) {
    return {
      ...fail(409, PRICE_UPDATED),
      quote: { faceAmount: (faceC * n) / 100, payAmount: total, customerCashback: (cashC * n) / 100, paymentFee: (feeC * n) / 100 },
    }
  }

  const capped = await checkBotPendingCaps(d.caps, "bundle", "hubtel_data_orders", c)
  if (capped) return capped

  const unit: BotSpecialUnitRow = {
    network: "MTN", service_key: prep.serviceKey, beneficiary_phone: prep.phone233,
    bundle_value: s.unit.value, bundle_display: s.unit.display, bundle_category: s.unit.category,
    amount: faceC / 100, paid_amount: unitPayC / 100, payment_fee_amount: feeC / 100,
    ...snapshot(q, c.shopId),
  }
  const rows = Array.from({ length: n }, () => ({ ...unit }))

  const res = await d.createBotSpecialOrders({ surface: c.botSurface, buyer: c.buyerPhone, shop: c.shopId, groupKey: key, n, rows, total })
  if (res.ok) {
    // replay: lost a same-key race, the earlier call owns the group. Either way the stored rows are the truth.
    if (res.replay || res.orderIds.length !== n) return readGroup(d, c, key)
    return { ok: true, order: { id: res.orderIds[0], groupId: res.groupId, n, payAmount: total } }
  }
  if (res.error === "unavailable") return fail(503, UNAVAILABLE)
  console.error("[bot-special] rpc refused:", res.error, "key length", key.length, "n", n)
  if (res.error === "bad_input") return fail(400, "Could not place this order. Please try again.")
  // conflict: a unique clash that was not a replay. If the group is there by key, it is the answer; else unknown.
  return readGroup(d, c, key)
}
