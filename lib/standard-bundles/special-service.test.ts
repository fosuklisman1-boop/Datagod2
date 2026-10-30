import { describe, it, expect } from "vitest"
import { buySpecial, SPECIAL_PRICE_CHANGED, type SpecialDeps, type SpecialChildRow, type SpecialRpcArgs } from "./special-service"
import { buyBundle, INSUFFICIENT, NOT_AVAILABLE_FOR_NUMBER, PRICES_REFRESHED, type DataOrderRow } from "./service"
import { signBundleToken, signSpecialToken, BUNDLE_TOKEN_TTL_MS, type VerifiedBundle } from "./token"
import type { BundlesConfig } from "./config"
import { DEFAULT_NETWORK_PREFIXES, type NetworkPrefixMap } from "@/lib/phone-format"
import type { HubtelCsTx } from "@/lib/hubtel-cs/types"
import { resolveCashbackConfig, type CashbackConfig } from "@/lib/cashback/config"

const T0 = 1_800_000_000_000
const SECRET = "s".repeat(40)
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e"
const KEY2 = "1f8fad5b-d9cb-469f-a165-70867728950e"
const PHONE = "0244123456"
const PHONE233 = "233244123456"
const UNIT = { value: "RACT_Data_GHC_3_Others", amount: 3, display: "406.89MB", category: "Data" }

const cfgOn = (): BundlesConfig => ({
  enabled: true,
  networks: {
    MTN: { enabled: true, hiddenCategories: [], referenceNumber: "233246912184" },
    TELECEL: { enabled: true, hiddenCategories: [], referenceNumber: "233206439599" },
    AT: { enabled: true, hiddenCategories: [], referenceNumber: "233273833933" },
  },
  special: { enabled: true, multiples: [3, 5, 8, 10, 15], unitAmount: 3, unitValue: UNIT.value },
})

// data_mtn at 3%, customer share 50%: one GHS 3 unit => 4.5 pesewas floored to 4 (pay 2.96). Pricing GHS 15 in one
// go would floor 22.5 to 22 (pay 14.78), so per-unit flooring (5 x 2.96 = 14.80) is observable.
const CB = (): CashbackConfig => resolveCashbackConfig({
  enabled: true,
  surfaces: { dashboard: true },
  rates: { "data_mtn:hubtel": 3 },
  shares: { bundles: { customer: 50, dealer: 75, storefrontCustomer: 0, storefrontShop: 0 } },
})

type Child = SpecialChildRow

function make(over: Partial<SpecialDeps> = {}) {
  const orders: Child[] = []
  const tasks: Array<() => Promise<void>> = []
  const calls = {
    rpc: [] as SpecialRpcArgs[], purchase: [] as any[], alerts: [] as string[], urgent: [] as boolean[], query: 0, insert: 0, debit: 0,
  }
  const cfg = cfgOn()
  let cashback: CashbackConfig = resolveCashbackConfig({})
  const hub = { enabled: true, paused: false, services: { data_mtn: true, data_telecel: true, data_at: true } as Record<string, boolean> }
  let queryData: any[] = [{ Display: UNIT.display, Value: UNIT.value, Amount: UNIT.amount }, { Display: "1GB", Value: "RACT_Data_GHC_10_Others", Amount: 10 }]
  let wallet = 1000
  let rpcMode: "normal" | "bad_input" | "throw_committed" | "throw_none" = "normal"
  let now = T0
  let groupSeq = 0
  const debits: number[] = []

  const rpcCore = (a: SpecialRpcArgs) => {
    const first = orders.find(o => o.user_id === a.userId && o.idempotency_key === `${a.groupKey}:1`)
    if (first) {
      const g = first.special_group_id!
      return { ok: true as const, groupId: g, orderIds: orders.filter(o => o.special_group_id === g).map(o => o.id), replay: true }
    }
    if (rpcMode === "bad_input") return { ok: false as const, error: "bad_input" as const, detail: "total does not match the rows" }
    if (wallet < a.total) return { ok: false as const, error: "insufficient" as const }
    wallet -= a.total
    debits.push(a.total)
    const g = "g" + ++groupSeq
    const ids: string[] = []
    for (let i = 1; i <= a.n; i++) {
      const r = a.rows[i - 1]
      const id = "o" + (orders.length + 1)
      orders.push({
        ...r, id, reference_code: "SB-" + id.toUpperCase(), user_id: a.userId, channel: "dashboard",
        status: "pending", payment_status: "paid", idempotency_key: `${a.groupKey}:${i}`,
        hubtel_client_reference: null, commission: null, failure_reason: null, notes: null, created_at: "c", updated_at: "u",
        special_group_id: g, special_index: i,
      } as Child)
      ids.push(id)
    }
    return { ok: true as const, groupId: g, orderIds: ids, replay: false }
  }

  const d: SpecialDeps = {
    getCashbackConfig: async () => cashback,
    getBuyerTier: async () => "customer",
    getBundlesConfig: async () => cfg,
    getHubtelConfig: async () => hub,
    getPrefixConfig: async () => ({ enabled: true, map: DEFAULT_NETWORK_PREFIXES as NetworkPrefixMap }),
    query: async () => { calls.query++; return { ok: true, data: queryData } },
    purchase: async (i) => { calls.purchase.push(i); return { client_reference: "CR-" + i.orderId, state: "pending" } as HubtelCsTx },
    findOrderByIdempotencyKey: async (u, k) => { const o = orders.find(x => x.user_id === u && x.idempotency_key === k); return o ? { ...o } : null },
    insertOrder: async (r) => {
      calls.insert++
      const o = { ...r, id: "o" + (orders.length + 1), hubtel_client_reference: null, commission: null, failure_reason: null, notes: null, created_at: "", updated_at: "" } as DataOrderRow
      orders.push(o)
      return { ...o }
    },
    getOrder: async (id) => { const o = orders.find(x => x.id === id); return o ? { ...o } : null },
    updateOrder: async (id, patch, only, pay) => {
      const o = orders.find(x => x.id === id)!
      if (only && !only.includes(o.status)) return 0
      if (pay && o.payment_status !== pay) return 0
      Object.assign(o, patch)
      return 1
    },
    debitOrder: async () => { calls.debit++; return "ok" },
    alert: async (m, u) => { calls.alerts.push(m); calls.urgent.push(!!u) },
    newReference: () => "SB-NEW",
    secret: SECRET,
    now: () => now,
    createSpecialOrders: async (a) => {
      calls.rpc.push(JSON.parse(JSON.stringify(a)))
      if (rpcMode === "throw_none") throw new Error("socket hang up")
      const r = rpcCore(a)
      if (rpcMode === "throw_committed") throw new Error("socket hang up")
      return r
    },
    listSpecialGroup: async (u, g) =>
      orders.filter(o => o.user_id === u && o.special_group_id === g).sort((a, b) => a.special_index! - b.special_index!).map(o => ({ ...o })),
    schedule: (fn) => { tasks.push(fn) },
    ...over,
  }
  return {
    d, orders, calls, cfg, hub, tasks, debits,
    setQueryData: (x: any[]) => { queryData = x },
    setWallet: (w: number) => { wallet = w },
    setCashback: (c: CashbackConfig) => { cashback = c },
    setRpcMode: (m: typeof rpcMode) => { rpcMode = m },
    setNow: (t: number) => { now = t },
    runTasks: async () => { for (const t of tasks.splice(0)) await t() },
  }
}

const unitTok = (over: Partial<VerifiedBundle> = {}, issuedAt = T0 - 1000) =>
  signBundleToken({ network: "MTN", ...UNIT, issuedAt, ...over }, SECRET)
const specialTok = (n = 3, unitOver: Partial<VerifiedBundle> = {}, issuedAt = T0 - 1000) =>
  signSpecialToken({ unitToken: unitTok(unitOver, issuedAt), n, issuedAt }, SECRET)
const buy = (m: ReturnType<typeof make>, over: Partial<{ token: string; phone: string; idempotencyKey: string; expectedPay: number; channel: any }> = {}, n = 3) =>
  buySpecial(m.d, "u1", { token: specialTok(n), phone: PHONE, idempotencyKey: KEY, expectedPay: n * 3, ...over })

const UNIT_ROW = {
  network: "MTN", service_key: "data_mtn", beneficiary_phone: PHONE233, bundle_value: UNIT.value,
  bundle_display: UNIT.display, bundle_category: UNIT.category, amount: 3, paid_amount: 3,
}

describe("buySpecial — happy path", () => {
  it("one RPC call with N identical unit rows and p_total from the same N; nothing dispatched before after()", async () => {
    const m = make()
    const r = await buy(m)
    expect(r.ok).toBe(true)
    expect(m.calls.rpc).toHaveLength(1)
    expect(m.calls.rpc[0]).toEqual({ userId: "u1", groupKey: KEY, n: 3, rows: [UNIT_ROW, UNIT_ROW, UNIT_ROW], total: 9 })
    expect(m.debits).toEqual([9])
    // Never the single-order path.
    expect([m.calls.insert, m.calls.debit]).toEqual([0, 0])
    expect(m.calls.purchase).toHaveLength(0)
    expect(m.tasks).toHaveLength(1)
    if (!r.ok) return
    expect(r.special).toEqual({ groupId: "g1", n: 3 })
    expect(r.replay).toBe(false)
    expect(r.order).toMatchObject({
      reference_code: "SB-O1", network: "MTN", beneficiary_phone: PHONE233, amount: 9, paid_amount: 9, cashback_amount: 0,
      status: "pending", payment_status: "paid", bundle_display: "1.22GB",
    })
  })

  it("after(): children dispatched one after another, in index order, each a unit purchase", async () => {
    const m = make()
    await buy(m)
    await m.runTasks()
    expect(m.calls.purchase.map(p => p.orderId)).toEqual(["o1", "o2", "o3"])
    for (const p of m.calls.purchase) {
      expect(p).toEqual({ serviceKey: "data_mtn", destination: PHONE233, amount: 3, bundle: UNIT.value, orderTable: "hubtel_data_orders", orderId: p.orderId })
    }
    expect(m.orders.map(o => o.status)).toEqual(["processing", "processing", "processing"])
  })

  it("cashback is floored per unit: 5 x 2.96 = 14.80 (never the 15.00 quote's 14.78)", async () => {
    const m = make(); m.setCashback(CB())
    const r = await buy(m, { token: specialTok(5), expectedPay: 14.8 }, 5)
    expect(r.ok).toBe(true)
    const row = {
      ...UNIT_ROW, paid_amount: 2.96, cashback_amount: 0.04, shop_share_amount: 0, cashback_rate: 3, cashback_share: 50,
      cashback_provider: "hubtel", expected_commission: 0.09,
    }
    expect(m.calls.rpc[0]).toEqual({ userId: "u1", groupKey: KEY, n: 5, rows: [row, row, row, row, row], total: 14.8 })
    expect(r.ok && r.order).toMatchObject({ amount: 15, paid_amount: 14.8, cashback_amount: 0.2 })
  })

  it("Special ignores the Data category's hidden setting (its own switch governs it)", async () => {
    const m = make(); m.cfg.networks.MTN.hiddenCategories = ["Data"]
    expect((await buy(m)).ok).toBe(true)
    expect(m.calls.rpc).toHaveLength(1)
  })
})

describe("buySpecial — 409 on price drift, nothing charged", () => {
  it("expectedPay != n x unit pay", async () => {
    const m = make(); m.setCashback(CB())
    const r = await buy(m, { token: specialTok(5), expectedPay: 14.78 }, 5)
    expect(r).toEqual({ ok: false, status: 409, error: SPECIAL_PRICE_CHANGED, quote: { faceAmount: 15, payAmount: 14.8, customerCashback: 0.2 } })
    expect(SPECIAL_PRICE_CHANGED).toBe("Price changed. Please try again.")
    expect(m.calls.rpc).toHaveLength(0)
  })
  it("missing expectedPay => 409 with the quote", async () => {
    const m = make()
    const r = await buySpecial(m.d, "u1", { token: specialTok(3), phone: PHONE, idempotencyKey: KEY })
    expect(r).toMatchObject({ ok: false, status: 409, error: SPECIAL_PRICE_CHANGED, quote: { payAmount: 9 } })
    expect(m.calls.rpc).toHaveLength(0)
  })
})

describe("buySpecial — re-checks (each refused before the RPC)", () => {
  const refused = async (m: ReturnType<typeof make>, r: Awaited<ReturnType<typeof buySpecial>>, status: number, error?: string) => {
    expect(r).toMatchObject({ ok: false, status, ...(error ? { error } : {}) })
    expect(m.calls.rpc).toHaveLength(0)
    expect(m.tasks).toHaveLength(0)
  }
  it("switch off => 403", async () => {
    const m = make(); m.cfg.special.enabled = false
    await refused(m, await buy(m), 403)
  })
  it("bundles master or MTN off => 403; Hubtel paused => 503", async () => {
    const a = make(); a.cfg.networks.MTN.enabled = false
    await refused(a, await buy(a), 403)
    const b = make(); b.hub.paused = true
    await refused(b, await buy(b), 503)
  })
  it("n not in the current multiples => 409", async () => {
    const m = make(); m.cfg.special.multiples = [5, 8]
    await refused(m, await buy(m), 409, PRICES_REFRESHED)
  })
  it("admin changed the unit value => 409", async () => {
    const m = make(); m.cfg.special.unitValue = "RACT_Data_GHC_5_Others"
    await refused(m, await buy(m), 409, PRICES_REFRESHED)
  })
  it("admin changed the unit amount => 409", async () => {
    const m = make(); m.cfg.special.unitAmount = 3.5
    await refused(m, await buy(m), 409, PRICES_REFRESHED)
  })
  it("live unit amount changed at Hubtel => 409", async () => {
    const m = make(); m.setQueryData([{ Display: UNIT.display, Value: UNIT.value, Amount: 3.5 }])
    await refused(m, await buy(m), 409, NOT_AVAILABLE_FOR_NUMBER)
  })
  it("live unit value gone at Hubtel => 409", async () => {
    const m = make(); m.setQueryData([{ Display: "x", Value: "RACT_Data_GHC_5_Others", Amount: 3 }])
    await refused(m, await buy(m), 409, NOT_AVAILABLE_FOR_NUMBER)
  })
  it("expired special token => 409", async () => {
    const m = make(); m.setNow(T0 + BUNDLE_TOKEN_TTL_MS + 5000)
    await refused(m, await buy(m), 409, PRICES_REFRESHED)
  })
  it("tampered / garbage special token => 409", async () => {
    const m = make()
    const [b, s] = specialTok().split(".")
    await refused(m, await buy(m, { token: `${b}.${s}x` }), 409, PRICES_REFRESHED)
    await refused(m, await buy(m, { token: "junk" }), 409, PRICES_REFRESHED)
  })
  it("a special token whose unit token is not the configured unit => 409", async () => {
    const m = make()
    const tok = specialTok(3, { value: "RACT_Data_GHC_10_Others", amount: 10 })
    await refused(m, await buy(m, { token: tok, expectedPay: 30 }), 409, PRICES_REFRESHED)
  })
  it("a normal bundle token given to buySpecial => 409", async () => {
    const m = make()
    await refused(m, await buy(m, { token: unitTok() }), 409, PRICES_REFRESHED)
  })
  it("a special token given to the normal buyBundle => 409, nothing written", async () => {
    const m = make()
    const r = await buyBundle(m.d, "u1", { token: specialTok(), phone: PHONE, idempotencyKey: KEY })
    expect(r).toEqual({ ok: false, status: 409, error: PRICES_REFRESHED })
    expect([m.calls.insert, m.calls.debit, m.calls.rpc.length, m.calls.query]).toEqual([0, 0, 0, 0])
  })
  it("recipient checked exactly like buyBundle: invalid number / other network's prefix => 400", async () => {
    const m = make()
    await refused(m, await buy(m, { phone: "12345" }), 400, "Enter a valid Ghana mobile number")
    await refused(m, await buy(m, { phone: "0201234567" }), 400)
  })
  it("invalid key, a non-dashboard channel, missing user => refused with no reads", async () => {
    const m = make()
    await refused(m, await buy(m, { idempotencyKey: "bad key" }), 400)
    await refused(m, await buy(m, { channel: "api" }), 400)
    await refused(m, await buySpecial(m.d, "", { token: specialTok(), phone: PHONE, idempotencyKey: KEY, expectedPay: 9 }), 401)
    expect(m.calls.query).toBe(0)
  })
  it("a normal order already holds this key => 409, no RPC", async () => {
    const m = make()
    await m.d.insertOrder({ user_id: "u1", idempotency_key: KEY, status: "processing", payment_status: "paid" } as any)
    await refused(m, await buy(m), 409)
  })
})

describe("buySpecial — replay", () => {
  it("same key again (different n and phone, even an expired token): the EARLIER group, no second RPC or debit", async () => {
    const m = make()
    await buy(m)
    await m.runTasks()
    m.orders.forEach(o => { o.status = "completed" })
    m.setNow(T0 + BUNDLE_TOKEN_TTL_MS + 5000)
    const r = await buy(m, { token: specialTok(5), phone: "0544123456", expectedPay: 15 }, 5)
    expect(r.ok).toBe(true)
    expect(m.calls.rpc).toHaveLength(1)
    expect(m.debits).toEqual([9])
    expect(m.tasks).toHaveLength(0)
    if (!r.ok) return
    expect(r.replay).toBe(true)
    expect(r.special).toEqual({ groupId: "g1", n: 3 })
    expect(r.order).toMatchObject({ beneficiary_phone: PHONE233, amount: 9, status: "completed", payment_status: "paid", reference_code: "SB-O1" })
  })
  it("mixed child outcomes read as processing (admin review), never completed", async () => {
    const m = make()
    await buy(m)
    m.orders[0].status = "completed"; m.orders[1].status = "failed"; m.orders[2].status = "completed"
    const r = await buy(m)
    expect(r.ok && r.order.status).toBe("processing")
  })
  it("RPC reports replay (lost a race): the earlier group, nothing dispatched", async () => {
    const m = make()
    await buy(m)
    m.tasks.length = 0
    const blind = { ...m.d, findOrderByIdempotencyKey: async () => null }
    const r = await buySpecial(blind, "u1", { token: specialTok(3), phone: PHONE, idempotencyKey: KEY, expectedPay: 9 })
    expect(r.ok && r.replay).toBe(true)
    expect(r.ok && r.special).toEqual({ groupId: "g1", n: 3 })
    expect(m.debits).toEqual([9])
    expect(m.tasks).toHaveLength(0)
  })
  it("replay lookup failing => 503, no RPC", async () => {
    const m = make()
    const r = await buySpecial({ ...m.d, findOrderByIdempotencyKey: async () => { throw new Error("db") } }, "u1",
      { token: specialTok(3), phone: PHONE, idempotencyKey: KEY, expectedPay: 9 })
    expect(r).toMatchObject({ ok: false, status: 503 })
    expect(m.calls.rpc).toHaveLength(0)
  })
})

describe("buySpecial — RPC outcomes", () => {
  it("INSUFFICIENT_FUNDS => 402 with the normal path's message; nothing written or dispatched", async () => {
    const m = make(); m.setWallet(8.99)
    const r = await buy(m)
    expect(r).toEqual({ ok: false, status: 402, error: INSUFFICIENT })
    expect(m.orders).toHaveLength(0)
    expect(m.tasks).toHaveLength(0)
  })
  it("BAD_INPUT => 400", async () => {
    const m = make(); m.setRpcMode("bad_input")
    expect(await buy(m)).toMatchObject({ ok: false, status: 400 })
    expect(m.tasks).toHaveLength(0)
  })
  it("RPC threw but the group committed => success, children scheduled", async () => {
    const m = make(); m.setRpcMode("throw_committed")
    const r = await buy(m)
    expect(r.ok && r.special).toEqual({ groupId: "g1", n: 3 })
    await m.runTasks()
    expect(m.calls.purchase.map(p => p.orderId)).toEqual(["o1", "o2", "o3"])
  })
  it("RPC threw and no group exists => 500 + urgent alert, key kept", async () => {
    const m = make(); m.setRpcMode("throw_none")
    const r = await buy(m)
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect(m.calls.urgent).toEqual([true])
    expect(m.tasks).toHaveLength(0)
  })
})

describe("buySpecial — dispatch isolation", () => {
  it("child 2's purchase throwing does not stop children 1 and 3", async () => {
    const m = make()
    const purchase = m.d.purchase
    m.d.purchase = async (i) => {
      if (i.orderId === "o2") { m.calls.purchase.push(i); throw new Error("boom") }
      return purchase(i)
    }
    await buy(m)
    await m.runTasks()
    expect(m.calls.purchase.map(p => p.orderId)).toEqual(["o1", "o2", "o3"])
    expect(m.orders.map(o => o.status)).toEqual(["processing", "pending", "processing"])
  })
  it("child 2's re-read throwing (an exception out of the loop body) does not stop children 1 and 3, and leaves a trace", async () => {
    const m = make()
    const getOrder = m.d.getOrder
    let reads = 0
    m.d.getOrder = async (id) => { if (id === "o2" && reads++ === 0) throw new Error("db down"); return getOrder(id) }
    await buy(m)
    await m.runTasks()
    expect(m.calls.purchase.map(p => p.orderId)).toEqual(["o1", "o3"])
    expect(m.calls.alerts.some(a => a.includes("SB-O2") || a.includes("o2"))).toBe(true)
  })
  it("after() unavailable => success still returned (paid) and an urgent alert", async () => {
    const m = make()
    m.d.schedule = () => { throw new Error("after() unavailable") }
    const r = await buy(m)
    expect(r.ok).toBe(true)
    expect(m.calls.urgent).toContain(true)
  })
})
