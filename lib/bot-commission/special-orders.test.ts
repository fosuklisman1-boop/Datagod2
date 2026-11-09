import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { quoteBots } from "@/lib/cashback/quote"
import { resolveCashbackConfig } from "@/lib/cashback/config"
import { resolveBundlesConfig } from "@/lib/standard-bundles/config"
import { __resetCatalogCache } from "@/lib/standard-bundles/catalog"
import { formatSpecialGb } from "@/lib/standard-bundles/special"
import { verifySpecialToken } from "@/lib/standard-bundles/token"
import type { BotContext } from "./context"
import type { BotCapDeps } from "./caps"
import type { BotOrderRow } from "./orders"
import {
  botCreateSpecialOrder, botSpecialPlans, findSpecialFirstChild, mapBotSpecialRpc,
  type BotSpecialChild, type BotSpecialDeps, type BotSpecialRpcArgs, type BotSpecialRpcResult,
} from "./special-orders"
import { botCapDeps } from "./runtime"

const NOW = 1_700_000_000_000
const SHOP = "11111111-2222-4333-8444-555555555555"
const BUYER = "233241234567"
const MAIN: BotContext = { botSurface: "hubtel_ussd", rail: "hubtel", buyerPhone: "0241234567" }
const SHOPCTX: BotContext = { botSurface: "hubtel_ussd", shopId: SHOP, rail: "hubtel", buyerPhone: "0241234567" }
const UNIT_VALUE = "RACT_Data_GHC_3_Others"
const KEY = "ussd-special-0001"

const CASHBACK = (over: Record<string, unknown> = {}) => resolveCashbackConfig({
  enabled: true,
  surfaces: { bots: true },
  rates: { "data_mtn:hubtel": 3.96 },
  shares: { bundles: { customer: 25, dealer: 0, storefrontCustomer: 20, storefrontShop: 40 } },
  botGroups: { bundles: true },
  botFees: { hubtel: { bundles: 1 } },
  ...over,
})

const SPECIAL = (over: Record<string, unknown> = {}) => ({
  enabled: true, ussdEnabled: true, multiples: [1, 5, 15], unitAmount: 3, unitValue: UNIT_VALUE, ...over,
})
const BUNDLES = (special: Record<string, unknown> = SPECIAL()) =>
  resolveBundlesConfig({ enabled: true, networks: { MTN: { enabled: true, hiddenCategories: [] } }, special })

const ITEMS = [
  { Value: UNIT_VALUE, Display: "406.89MB", Amount: 3 },
  { Value: "other_1GB", Display: "1GB", Amount: 10 },
]

function fakeCaps(opts: { block?: string; pending?: number } = {}) {
  const limits: string[] = []
  const caps: BotCapDeps = {
    limit: async (name) => (limits.push(name), name !== opts.block),
    countPending: async () => opts.pending ?? 0,
    now: () => NOW,
  }
  return { caps, limits }
}

type Stored = BotOrderRow & BotSpecialChild & { bot_surface: string; buyer_phone: string; idempotency_key: string }

function harness(over: Partial<BotSpecialDeps> & { cashback?: any; bundles?: any; rpc?: (a: BotSpecialRpcArgs, rows: Stored[]) => BotSpecialRpcResult; pending?: number } = {}) {
  const { caps, limits } = fakeCaps({ pending: over.pending })
  const rows: Stored[] = []
  const rpcCalls: BotSpecialRpcArgs[] = []
  let cashback = over.cashback ?? CASHBACK()
  const store = (a: BotSpecialRpcArgs): BotSpecialRpcResult => {
    const first = rows.find(r => r.idempotency_key === `${a.groupKey}:1`)
    if (first) return { ok: true, groupId: first.special_group_id, orderIds: rows.filter(r => r.special_group_id === first.special_group_id).map(r => r.id), replay: true }
    const groupId = `group-${rpcCalls.length}`
    const ids: string[] = []
    a.rows.forEach((row, i) => {
      const id = `child-${rows.length + 1}`
      ids.push(id)
      rows.push({
        id, reference_code: `SB-${id}`, amount: row.amount, paid_amount: row.paid_amount, payment_fee_amount: row.payment_fee_amount ?? 0,
        cashback_amount: row.cashback_amount ?? null, bot_surface: a.surface, buyer_phone: a.buyer,
        idempotency_key: `${a.groupKey}:${i + 1}`, special_group_id: groupId, special_index: i + 1,
      })
    })
    return { ok: true, groupId, orderIds: ids, replay: false }
  }
  const d: BotSpecialDeps = {
    getCashbackConfig: async () => cashback,
    getBuyerTier: async () => "customer",
    getBundlesConfig: async () => over.bundles ?? BUNDLES(),
    getHubtelConfig: async () => ({ enabled: true, paused: false, services: { data_mtn: true } }) as any,
    query: async () => ({ ok: true, data: ITEMS as any }),
    purchase: async () => { throw new Error("never in create") },
    getPrefixConfig: async () => ({ enabled: true, map: { MTN: ["24", "54", "55", "59", "25", "53"], TELECEL: ["20", "50"], AT: ["26", "27", "56", "57"] } }),
    findOrderByIdempotencyKey: async () => { throw new Error("dashboard lookup must not be used") },
    insertOrder: async () => { throw new Error("dashboard insert must not be used") },
    getOrder: async () => null,
    updateOrder: async () => 0,
    debitOrder: async () => { throw new Error("never debits") },
    alert: async () => {},
    newReference: () => "SB-REF",
    secret: "s3cret",
    now: () => NOW,
    async findBotBundleOrder(surface, phone, key) {
      return rows.find(r => r.bot_surface === surface && r.buyer_phone === phone && r.idempotency_key === key) ?? null
    },
    insertBotBundleOrder: async () => { throw new Error("single insert must not be used for Special") },
    async createBotSpecialOrders(a) {
      rpcCalls.push(a)
      return over.rpc ? over.rpc(a, rows) : store(a)
    },
    async listBotSpecialGroup(surface, phone, key) {
      const first = rows.find(r => r.bot_surface === surface && r.buyer_phone === phone && r.idempotency_key === `${key}:1`)
      if (!first) return []
      return rows.filter(r => r.special_group_id === first.special_group_id).sort((a, b) => a.special_index - b.special_index)
    },
    caps,
    ...over,
  }
  return { d, rows, rpcCalls, limits, setCashback: (c: any) => { cashback = c } }
}

const planFor = async (d: BotSpecialDeps, ctx: BotContext, n: number) => {
  const r = await botSpecialPlans(d, ctx)
  if (!r.ok) throw new Error("plans failed " + JSON.stringify(r))
  const p = r.plans.find(x => x.n === n)
  if (!p) throw new Error("no plan " + n)
  return p
}

const unitQuote = (shop: boolean, cfg = CASHBACK()) =>
  quoteBots({ serviceKey: "data_mtn", provider: "hubtel", faceAmount: 3, rail: "hubtel", shop }, cfg)
const pesewas = (n: number) => Math.round(n * 100)

beforeEach(() => __resetCatalogCache())

describe("botSpecialPlans", () => {
  it("lists one plan per multiple, signed, with the display and face of N units", async () => {
    const { d } = harness()
    const r: any = await botSpecialPlans(d, MAIN)
    expect(r.ok).toBe(true)
    expect(r.plans.map((p: any) => p.n)).toEqual([1, 5, 15])
    const p5 = r.plans.find((p: any) => p.n === 5)
    expect(p5).toMatchObject({ display: formatSpecialGb(5 * 406.89), faceAmount: 15, token: expect.any(String) })
    expect(verifySpecialToken(p5.token, "s3cret", NOW)).toMatchObject({ n: 5 })
  })

  it("price is N x the per-unit quoteBots price, never quoteBots of the total", async () => {
    const { d } = harness()
    const q = unitQuote(false)
    const r: any = await botSpecialPlans(d, MAIN)
    for (const p of r.plans) expect(pesewas(p.payAmount)).toBe(p.n * pesewas(q.payAmount))
    const p5 = r.plans.find((p: any) => p.n === 5)
    const ofTotal = quoteBots({ serviceKey: "data_mtn", provider: "hubtel", faceAmount: 15, rail: "hubtel", shop: false }, CASHBACK())
    expect(pesewas(p5.payAmount)).not.toBe(pesewas(ofTotal.payAmount))
  })

  it.each([
    ["special off", { bundles: BUNDLES(SPECIAL({ enabled: false })) }],
    ["ussd off", { bundles: BUNDLES(SPECIAL({ ussdEnabled: false })) }],
    ["bots bundles gate off", { cashback: CASHBACK({ botGroups: { bundles: false } }) }],
    ["unit not in live catalog", { bundles: BUNDLES(SPECIAL({ unitValue: "NOT_THERE" })) }],
    ["unit amount differs", { bundles: BUNDLES(SPECIAL({ unitAmount: 4 })) }],
  ])("%s => empty plans", async (_n, over) => {
    const { d } = harness(over as any)
    expect(await botSpecialPlans(d, MAIN)).toEqual({ ok: true, plans: [] })
  })

  it("only on hubtel_ussd", async () => {
    const { d } = harness()
    expect(await botSpecialPlans(d, { ...MAIN, botSurface: "whatsapp" })).toEqual({ ok: true, plans: [] })
  })

  it("Hubtel paused => empty plans; config read failure => 503", async () => {
    const paused = harness({ getHubtelConfig: async () => ({ enabled: true, paused: true, services: { data_mtn: true } }) as any })
    expect(await botSpecialPlans(paused.d, MAIN)).toEqual({ ok: true, plans: [] })
    const broken = harness({ getBundlesConfig: async () => { throw new Error("db") } })
    expect(await botSpecialPlans(broken.d, MAIN)).toMatchObject({ ok: false, status: 503 })
  })

  it("ignores MTN hidden categories (Special is governed by its own switch)", async () => {
    const bundles = resolveBundlesConfig({ enabled: true, networks: { MTN: { enabled: true, hiddenCategories: ["Data", "Others", "Video"] } }, special: SPECIAL() })
    const { d } = harness({ bundles })
    const r: any = await botSpecialPlans(d, MAIN)
    expect(r.plans).toHaveLength(3)
  })
})

describe("botCreateSpecialOrder", () => {
  const input = (token: string, p: number, key = KEY) => ({ token, recipient: "0541112222", idempotencyKey: key, expectedPay: p })

  it("main: ONE rpc call with N identical unit rows, per-unit paid + fee, no shop share; id = child 1", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r).toEqual({ ok: true, order: { id: "child-1", groupId: "group-1", n: 5, payAmount: plan.payAmount } })
    expect(h.rpcCalls).toHaveLength(1)
    const a = h.rpcCalls[0]
    const q = unitQuote(false)
    expect(a).toMatchObject({ surface: "hubtel_ussd", buyer: BUYER, shop: null, groupKey: KEY, n: 5, total: plan.payAmount })
    expect(a.rows).toHaveLength(5)
    expect(new Set(a.rows.map(x => JSON.stringify(x))).size).toBe(1)
    expect(a.rows[0]).toMatchObject({
      network: "MTN", service_key: "data_mtn", beneficiary_phone: "233541112222", bundle_value: UNIT_VALUE, bundle_display: "406.89MB",
      amount: 3, paid_amount: q.payAmount, payment_fee_amount: q.paymentFee, cashback_amount: q.customerCashback, shop_share_amount: 0,
    })
    // The RPC's own invariants, checked here too.
    const row = a.rows[0]
    expect(pesewas(row.paid_amount)).toBe(pesewas(row.amount) - pesewas(row.cashback_amount ?? 0) + pesewas(row.payment_fee_amount ?? 0))
    expect(pesewas(a.total)).toBe(5 * pesewas(row.paid_amount))
  })

  it("shop: shop_share_amount is the per-unit share and the shop id is passed", async () => {
    const h = harness()
    const plan = await planFor(h.d, SHOPCTX, 5)
    const q = unitQuote(true)
    expect(q.shopShare).toBeGreaterThan(0)
    const r = await botCreateSpecialOrder(h.d, SHOPCTX, input(plan.token, plan.payAmount))
    expect(r.ok).toBe(true)
    expect(h.rpcCalls[0].shop).toBe(SHOP)
    expect(h.rpcCalls[0].rows[0].shop_share_amount).toBe(q.shopShare)
    expect(pesewas(h.rpcCalls[0].rows[0].paid_amount)).toBe(pesewas(q.payAmount))
  })

  it("cashback not applied: nulls in the snapshot, paid = face + fee", async () => {
    const cfg = CASHBACK({ rates: {} })
    const h = harness({ cashback: cfg })
    const plan = await planFor(h.d, MAIN, 1)
    const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r.ok).toBe(true)
    const q = unitQuote(false, cfg)
    expect(h.rpcCalls[0].rows[0]).toMatchObject({ paid_amount: q.payAmount, payment_fee_amount: q.paymentFee, cashback_amount: null })
  })

  it("surface must be hubtel_ussd: 403 and nothing written", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    const ctx: BotContext = { botSurface: "whatsapp", rail: "hubtel", buyerPhone: "0241234567" }
    const r = await botCreateSpecialOrder(h.d, ctx, input(plan.token, plan.payAmount))
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.limits).toHaveLength(0)
  })

  it("expectedPay mismatch => 409 with the live quote, no write, no cap slot", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    const r: any = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount + 1))
    const q = unitQuote(false)
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(pesewas(r.quote.payAmount)).toBe(5 * pesewas(q.payAmount))
    expect(r.quote.faceAmount).toBe(15)
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.limits).toHaveLength(0)
  })

  it("missing expectedPay => 400", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    const r = await botCreateSpecialOrder(h.d, MAIN, { ...input(plan.token, 0), expectedPay: undefined })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it("a size no longer in multiples => PRICES_REFRESHED (409), no write", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 15)
    h.d.getBundlesConfig = async () => BUNDLES(SPECIAL({ multiples: [1, 5] }))
    const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r).toMatchObject({ ok: false, status: 409, error: "Prices refreshed — pick the bundle again" })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it.each([
    ["ussd switch turned off", () => BUNDLES(SPECIAL({ ussdEnabled: false }))],
    ["special turned off", () => BUNDLES(SPECIAL({ enabled: false }))],
  ])("%s after the plan was shown => 403, no write", async (_n, cfg) => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    h.d.getBundlesConfig = async () => cfg()
    const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it("unit changed after the plan was shown => PRICES_REFRESHED", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    h.d.getBundlesConfig = async () => BUNDLES(SPECIAL({ unitAmount: 4 }))
    const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it("forged or garbage token => 409, no write", async () => {
    const h = harness()
    const r = await botCreateSpecialOrder(h.d, MAIN, input("garbage", 10))
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it("bad recipient => 400, no write", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    const r = await botCreateSpecialOrder(h.d, MAIN, { ...input(plan.token, plan.payAmount), recipient: "123" })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it("invalid key => 400", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    expect(await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount, "a:b"))).toMatchObject({ ok: false, status: 400 })
  })

  it("caps run ONCE per create; 4 pending singles still allow a size 15 group", async () => {
    const h = harness({ pending: 4 })
    const plan = await planFor(h.d, MAIN, 15)
    const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r.ok).toBe(true)
    expect(h.limits).toEqual(["bot_bundle_cap_phone"])
    expect(h.rpcCalls).toHaveLength(1)
  })

  it("at the pending cap => 429, no write", async () => {
    const h = harness({ pending: 5 })
    const plan = await planFor(h.d, MAIN, 5)
    const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r).toMatchObject({ ok: false, status: 429 })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it("repeat with the same key => same order.id, no second write, no second cap check, stored price", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    const a: any = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    const limitsAfterFirst = h.limits.length
    // The price changes in between, and the repeat carries a stale token and a wrong expectedPay.
    h.setCashback(CASHBACK({ rates: {} }))
    const b: any = await botCreateSpecialOrder(h.d, MAIN, input("stale", 1))
    expect(b.ok).toBe(true)
    expect(b.order).toEqual(a.order)
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.limits).toHaveLength(limitsAfterFirst)
  })

  it("a repeat is answered even when every gate has since closed", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    const a: any = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    h.d.getBundlesConfig = async () => { throw new Error("down") }
    h.setCashback(CASHBACK({ botGroups: { bundles: false } }))
    const b: any = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(b).toEqual(a)
  })

  it("replay price is the sum of the stored children, never the new request", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    for (const r of h.rows) r.paid_amount = 2.5 // stored price differs from anything quotable now
    const b: any = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(b.order).toMatchObject({ n: 5, payAmount: 12.5, id: "child-1" })
  })

  it("rpc replay:true (lost a same-key race) => the winner's group and stored price", async () => {
    const h = harness({
      rpc: (a, rows) => {
        a.rows.forEach((_r, i) => rows.push({
          id: `win-${i + 1}`, reference_code: "SB-W", amount: 3, paid_amount: 2, payment_fee_amount: 0, cashback_amount: null,
          bot_surface: a.surface, buyer_phone: a.buyer, idempotency_key: `${a.groupKey}:${i + 1}`, special_group_id: "winner", special_index: i + 1,
        }))
        return { ok: true, groupId: "winner", orderIds: a.rows.map((_r, i) => `win-${i + 1}`), replay: true }
      },
    })
    const plan = await planFor(h.d, MAIN, 5)
    const r: any = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r.order).toEqual({ id: "win-1", groupId: "winner", n: 5, payAmount: 10 })
  })

  it("a normal bot order already holding this exact key => 409, no write", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    h.rows.push({
      id: "plain-1", reference_code: "SB-P", amount: 10, paid_amount: 10, payment_fee_amount: 0, cashback_amount: null,
      bot_surface: "hubtel_ussd", buyer_phone: BUYER, idempotency_key: KEY, special_group_id: null as any, special_index: null as any,
    })
    const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it("the first-child lookup read failing => 503, no write", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    h.d.findBotBundleOrder = async () => { throw new Error("db") }
    const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
    expect(r).toMatchObject({ ok: false, status: 503 })
    expect(h.rpcCalls).toHaveLength(0)
  })

  describe("rpc failures", () => {
    let spy: ReturnType<typeof vi.spyOn>[]
    beforeEach(() => { spy = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})] })
    afterEach(() => spy.forEach(s => s.mockRestore()))
    const logged = () => JSON.stringify(spy.flatMap(s => s.mock.calls))

    it("bad_input => 400, nothing logged with the phone", async () => {
      const h = harness({ rpc: () => ({ ok: false, error: "bad_input" }) })
      const plan = await planFor(h.d, MAIN, 5)
      const r = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
      expect(r).toMatchObject({ ok: false, status: 400 })
      expect(logged()).not.toContain("241234567")
      expect(logged()).not.toContain("541112222")
    })

    it("unavailable (function missing) => 503", async () => {
      const h = harness({ rpc: () => ({ ok: false, error: "unavailable" }) })
      const plan = await planFor(h.d, MAIN, 5)
      expect(await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))).toMatchObject({ ok: false, status: 503 })
    })

    it("conflict with the group visible by key => returns it (stored price)", async () => {
      const h = harness({
        rpc: (a, rows) => {
          a.rows.forEach((_r, i) => rows.push({
            id: `c-${i + 1}`, reference_code: "SB-C", amount: 3, paid_amount: 3, payment_fee_amount: 0, cashback_amount: null,
            bot_surface: a.surface, buyer_phone: a.buyer, idempotency_key: `${a.groupKey}:${i + 1}`, special_group_id: "g-c", special_index: i + 1,
          }))
          return { ok: false, error: "conflict" }
        },
      })
      const plan = await planFor(h.d, MAIN, 5)
      const r: any = await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))
      expect(r.order).toEqual({ id: "c-1", groupId: "g-c", n: 5, payAmount: 15 })
    })

    it("conflict with no group found => 503", async () => {
      const h = harness({ rpc: () => ({ ok: false, error: "conflict" }) })
      const plan = await planFor(h.d, MAIN, 5)
      expect(await botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))).toMatchObject({ ok: false, status: 503 })
    })

    it("any other rpc error throws (outcome unknown), never a quiet failure", async () => {
      const h = harness({ createBotSpecialOrders: async () => { throw new Error("socket hang up") } })
      const plan = await planFor(h.d, MAIN, 5)
      await expect(botCreateSpecialOrder(h.d, MAIN, input(plan.token, plan.payAmount))).rejects.toThrow("socket hang up")
    })
  })
})

describe("findSpecialFirstChild", () => {
  it("returns child 1's id, or null", async () => {
    const h = harness()
    expect(await findSpecialFirstChild(h.d, MAIN, KEY)).toBeNull()
    const plan = await planFor(h.d, MAIN, 5)
    await botCreateSpecialOrder(h.d, MAIN, { token: plan.token, recipient: "0541112222", idempotencyKey: KEY, expectedPay: plan.payAmount })
    expect(await findSpecialFirstChild(h.d, MAIN, KEY)).toBe("child-1")
  })
  it("never leaks across buyers", async () => {
    const h = harness()
    const plan = await planFor(h.d, MAIN, 5)
    await botCreateSpecialOrder(h.d, MAIN, { token: plan.token, recipient: "0541112222", idempotencyKey: KEY, expectedPay: plan.payAmount })
    expect(await findSpecialFirstChild(h.d, { ...MAIN, buyerPhone: "0551234567" }, KEY)).toBeNull()
  })
  it("a read error throws", async () => {
    const h = harness({ findBotBundleOrder: async () => { throw new Error("db") } })
    await expect(findSpecialFirstChild(h.d, MAIN, KEY)).rejects.toThrow("db")
  })
})

describe("mapBotSpecialRpc", () => {
  const ok = { group_id: "g1", order_ids: ["a", "b"], replay: false }
  it("success", () => {
    expect(mapBotSpecialRpc(ok, null)).toEqual({ ok: true, groupId: "g1", orderIds: ["a", "b"], replay: false })
    expect(mapBotSpecialRpc({ ...ok, replay: true }, null)).toMatchObject({ replay: true })
  })
  it("BAD_INPUT, GROUP_CONFLICT, missing function", () => {
    expect(mapBotSpecialRpc(null, { message: "BAD_INPUT", code: "P0001" })).toEqual({ ok: false, error: "bad_input" })
    expect(mapBotSpecialRpc(null, { message: "GROUP_CONFLICT", code: "23505" })).toEqual({ ok: false, error: "conflict" })
    expect(mapBotSpecialRpc(null, { message: "x", code: "PGRST202" })).toEqual({ ok: false, error: "unavailable" })
    expect(mapBotSpecialRpc(null, { message: "x", code: "42883" })).toEqual({ ok: false, error: "unavailable" })
  })
  it("anything else throws, without the raw message", () => {
    expect(() => mapBotSpecialRpc(null, { message: "duplicate key ... (233241234567)", code: "23505" })).toThrow()
    try { mapBotSpecialRpc(null, { message: "secret 233241234567", code: "XX000" }) } catch (e) {
      expect(String((e as Error).message)).not.toContain("233241234567")
    }
  })
  it("a malformed success throws", () => {
    expect(() => mapBotSpecialRpc({ group_id: "g1" }, null)).toThrow()
    expect(() => mapBotSpecialRpc(null, null)).toThrow()
  })
})

describe("botCapDeps countPending: a Special group counts once", () => {
  function fakeDb() {
    const calls: [string, ...unknown[]][] = []
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (res: any) => res({ count: 3, error: null })
        return (...a: unknown[]) => { calls.push([prop, ...a]); return b }
      },
    })
    return { db: { from: (t: string) => { calls.push(["from", t]); return b } } as any, calls }
  }
  it("hubtel_data_orders excludes special_index > 1", async () => {
    const { db, calls } = fakeDb()
    const n = await botCapDeps(db).countPending("hubtel_data_orders", "buyer_phone", BUYER, "2026-01-01T00:00:00.000Z")
    expect(n).toBe(3)
    expect(calls).toContainEqual(["or", "special_index.is.null,special_index.lte.1"])
  })
  it("hubtel_bill_orders has no such column and is not filtered", async () => {
    const { db, calls } = fakeDb()
    await botCapDeps(db).countPending("hubtel_bill_orders", "buyer_phone", BUYER, "2026-01-01T00:00:00.000Z")
    expect(calls.some(c => c[0] === "or")).toBe(false)
  })
})
