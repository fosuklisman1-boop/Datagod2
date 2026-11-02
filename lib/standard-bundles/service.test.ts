import { describe, it, expect } from "vitest"
import {
  buyBundle, isValidIdempotencyKey, sameAmount, NOT_AVAILABLE_FOR_NUMBER, PRICES_REFRESHED,
  type BundlesDeps, type DataOrderRow, type BuyInput,
} from "./service"
import { signBundleToken, type VerifiedBundle } from "./token"
import type { BundlesConfig } from "./config"
import type { BundleNetwork } from "./categories"
import { DEFAULT_NETWORK_PREFIXES, type NetworkPrefixMap } from "@/lib/phone-format"
import { HubtelPausedError, HubtelOutcomeUnknownError, HubtelDuplicateOrderError } from "@/lib/hubtel-cs/errors"
import type { HubtelCsTx } from "@/lib/hubtel-cs/types"
import { resolveCashbackConfig, type CashbackConfig } from "@/lib/cashback/config"

const T0 = 1_800_000_000_000
const SECRET = "s".repeat(40)
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e"
const PHONES: Record<BundleNetwork, string> = { MTN: "0244123456", TELECEL: "0201234567", AT: "0261234567" }
const BUNDLES: Record<BundleNetwork, { value: string; amount: number; display: string; category: string }> = {
  MTN: { value: "RACT_Data_GHC_10_Others", amount: 10, display: "837.55MB", category: "Data" },
  TELECEL: { value: " 5.7 GB ", amount: 20.5, display: "30 Days - 5.7 GB", category: "Monthly" },
  AT: { value: "db_BigTime_Data_5GB", amount: 12.3, display: "5GB", category: "BigTime" },
}

const allOn = (): BundlesConfig => ({
  enabled: true,
  networks: {
    MTN: { enabled: true, hiddenCategories: [], referenceNumber: "233246912184" },
    TELECEL: { enabled: true, hiddenCategories: [], referenceNumber: "233206439599" },
    AT: { enabled: true, hiddenCategories: [], referenceNumber: "233273833933" },
  },
  special: { enabled: false, multiples: [3, 5, 8, 10, 15], unitAmount: 3, unitValue: "RACT_Data_GHC_3_Others" },
})

function make(over: Partial<BundlesDeps> = {}) {
  const orders: DataOrderRow[] = []
  const calls = { query: 0, purchase: 0, debit: 0, insert: 0, find: 0, alerts: [] as string[], urgent: [] as boolean[], purchaseInputs: [] as any[], queryArgs: [] as any[], debitAmounts: [] as number[] }
  const cfg = allOn()
  let cashback: CashbackConfig = resolveCashbackConfig({}) // off by default: every legacy test runs unchanged
  let tier: "customer" | "dealer" = "customer"
  const hub = { enabled: true, paused: false, services: { data_mtn: true, data_telecel: true, data_at: true } as Record<string, boolean> }
  const prefix = { enabled: true, map: DEFAULT_NETWORK_PREFIXES as NetworkPrefixMap }
  let queryData: any[] = Object.values(BUNDLES).map(b => ({ Display: b.display, Value: b.value, Amount: b.amount }))
  let queryResult: any = null
  let wallet: "ok" | "insufficient" | "not_found" | "throw_paid" | "throw_unpaid" = "ok"
  let txState: HubtelCsTx["state"] = "pending"
  const d: BundlesDeps = {
    getCashbackConfig: async () => cashback,
    getBuyerTier: async () => tier,
    getBundlesConfig: async () => cfg,
    getHubtelConfig: async () => hub,
    getPrefixConfig: async () => prefix,
    query: async (k, dest, p) => { calls.query++; calls.queryArgs.push([k, dest, p]); return queryResult ?? { ok: true, data: queryData } },
    purchase: async (i) => { calls.purchase++; calls.purchaseInputs.push(i); return { client_reference: "CR1", state: txState } as HubtelCsTx },
    findOrderByIdempotencyKey: async (u, k) => { calls.find++; const o = orders.find(x => x.user_id === u && x.idempotency_key === k); return o ? { ...o } : null },
    insertOrder: async (r) => {
      calls.insert++
      if (orders.some(x => x.user_id === r.user_id && x.idempotency_key === r.idempotency_key)) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" })
      }
      const o = { ...r, id: "o" + (orders.length + 1), hubtel_client_reference: null, commission: null, failure_reason: null, notes: null, created_at: "", updated_at: "" } as DataOrderRow
      orders.push(o)
      return { ...o }
    },
    updateOrder: async (id, patch, only, pay) => {
      const o = orders.find(x => x.id === id)!
      if (only && !only.includes(o.status)) return 0
      if (pay && o.payment_status !== pay) return 0
      Object.assign(o, patch)
      return 1
    },
    getOrder: async (id) => { const o = orders.find(x => x.id === id); return o ? { ...o } : null },
    debitOrder: async (id) => {
      calls.debit++
      const o = orders.find(x => x.id === id)!
      // Mirrors data_order_debit (0119): deducts COALESCE(paid_amount, amount).
      if (wallet === "ok" || wallet === "throw_paid") { o.payment_status = "paid"; calls.debitAmounts.push(o.paid_amount ?? o.amount) }
      if (wallet === "throw_paid" || wallet === "throw_unpaid") throw new Error("rpc down")
      return wallet
    },
    alert: async (m, u) => { calls.alerts.push(m); calls.urgent.push(!!u) },
    newReference: () => "DATA-" + (orders.length + 1),
    secret: SECRET,
    now: () => T0,
    ...over,
  }
  return {
    d, orders, calls, cfg, hub, prefix,
    setQueryData: (x: any[]) => { queryData = x },
    setQueryResult: (x: any) => { queryResult = x },
    setWallet: (w: typeof wallet) => { wallet = w },
    setTxState: (s: HubtelCsTx["state"]) => { txState = s },
    setCashback: (c: CashbackConfig) => { cashback = c },
    setTier: (t: "customer" | "dealer") => { tier = t },
    writes: () => calls.insert + calls.debit + calls.purchase,
  }
}

const tok = (network: BundleNetwork = "MTN", over: Partial<VerifiedBundle> = {}) =>
  signBundleToken({ network, ...BUNDLES[network], issuedAt: T0 - 1000, ...over }, SECRET)
const buy = (m: ReturnType<typeof make>, network: BundleNetwork = "MTN", over: Partial<{ token: string; phone: string; idempotencyKey: string; expectedPay: number }> = {}, d = m.d) =>
  buyBundle(d, "u1", { token: tok(network), phone: PHONES[network], idempotencyKey: KEY, ...over })

describe("isValidIdempotencyKey", () => {
  it("accepts uuids and 8-64 [A-Za-z0-9-]", () => {
    expect(isValidIdempotencyKey(KEY)).toBe(true)
    expect(isValidIdempotencyKey("abcdEFGH")).toBe(true)
    expect(isValidIdempotencyKey("a".repeat(64))).toBe(true)
  })
  it("rejects short, long, other chars and non-strings", () => {
    for (const bad of ["abc1234", "a".repeat(65), "abcd efgh", "abcd_efgh", "abcd.efgh", "abcdefgh\n", "", null, undefined, 12345678]) {
      expect(isValidIdempotencyKey(bad)).toBe(false)
    }
  })
})

describe("sameAmount", () => {
  it("compares at 2dp", () => {
    expect(sameAmount(10, 10.001)).toBe(true)
    expect(sameAmount(20.5, 20.50)).toBe(true)
    expect(sameAmount(10, 10.01)).toBe(false)
    expect(sameAmount(NaN, NaN)).toBe(false)
  })
})

describe("buyBundle — happy path per network", () => {
  for (const n of ["MTN", "TELECEL", "AT"] as const) {
    it(`${n}: re-queries the buyer's number, debits once, purchases once`, async () => {
      const m = make()
      const r = await buy(m, n)
      expect(r.ok && r.order).toMatchObject({ status: "processing", payment_status: "paid", hubtel_client_reference: "CR1", network: n })
      const phone233 = "233" + PHONES[n].slice(1)
      expect(m.calls.queryArgs[0]).toEqual([`data_${n.toLowerCase()}`, phone233, undefined])
      expect(m.calls.purchaseInputs[0]).toEqual({
        serviceKey: `data_${n.toLowerCase()}`, destination: phone233, amount: BUNDLES[n].amount,
        bundle: BUNDLES[n].value, orderTable: "hubtel_data_orders", orderId: "o1",
      })
      expect(m.orders[0]).toMatchObject({
        channel: "dashboard", beneficiary_phone: phone233, bundle_value: BUNDLES[n].value, bundle_display: BUNDLES[n].display,
        bundle_category: BUNDLES[n].category, idempotency_key: KEY, service_key: `data_${n.toLowerCase()}`,
      })
      expect([m.calls.insert, m.calls.debit, m.calls.purchase]).toEqual([1, 1, 1])
    })
  }
  it("accepts 233 / +233 phone input and stores 233 form", async () => {
    const m = make()
    await buy(m, "MTN", { phone: "+233 24 412 3456" })
    expect(m.orders[0].beneficiary_phone).toBe("233244123456")
  })
  it("claims pending -> processing ('Dispatching…') BEFORE purchase", async () => {
    const m = make()
    let seen = ""
    await buy(m, "MTN", {}, { ...m.d, purchase: async () => { seen = m.orders[0].status + "/" + m.orders[0].notes; return { client_reference: "CR9", state: "pending" } as HubtelCsTx } })
    expect(seen).toBe("processing/Dispatching…")
    expect(m.orders[0]).toMatchObject({ status: "processing", hubtel_client_reference: "CR9", notes: null })
  })
  it("fulfilled / failed tx states map to completed / failed", async () => {
    const a = make(); a.setTxState("fulfilled")
    const ra = await buy(a)
    expect(ra.ok && ra.order.status).toBe("completed")
    const b = make(); b.setTxState("failed")
    const r = await buy(b)
    expect(r.ok && r.order.status).toBe("failed")
  })
})

describe("Review Focus 1: bundle changed / not offered for the buyer's number => 409, nothing charged", () => {
  it("value missing for that number", async () => {
    const m = make(); m.setQueryData([{ Display: "x", Value: "RACT_Data_GHC_20_Others", Amount: 10 }])
    expect(await buy(m)).toEqual({ ok: false, status: 409, error: NOT_AVAILABLE_FOR_NUMBER })
    expect(m.writes()).toBe(0)
  })
  it("same value, price changed", async () => {
    const m = make(); m.setQueryData([{ Display: "837.55MB", Value: BUNDLES.MTN.value, Amount: 10.5 }])
    expect(await buy(m)).toMatchObject({ ok: false, status: 409, error: NOT_AVAILABLE_FOR_NUMBER })
    expect(m.writes()).toBe(0)
  })
  it("value matches only after trimming => still 409 (exact string compare)", async () => {
    const m = make(); m.setQueryData([{ Display: "x", Value: "5.7 GB", Amount: 20.5 }])
    expect(await buy(m, "TELECEL")).toMatchObject({ ok: false, status: 409 })
    expect(m.writes()).toBe(0)
  })
  it("identity is (value, amount): duplicate value with a different amount does not match; the right one does", async () => {
    const m = make()
    m.setQueryData([{ Display: "a", Value: "RACT_Data_Flexi_Bundle", Amount: 2 }, { Display: "b", Value: "RACT_Data_Flexi_Bundle", Amount: 5 }])
    const r = await buy(m, "MTN", { token: tok("MTN", { value: "RACT_Data_Flexi_Bundle", amount: 5 }) })
    expect(r.ok).toBe(true)
    expect(m.calls.purchaseInputs[0]).toMatchObject({ bundle: "RACT_Data_Flexi_Bundle", amount: 5 })
    const m2 = make(); m2.setQueryData([{ Display: "a", Value: "RACT_Data_Flexi_Bundle", Amount: 2 }])
    expect(await buy(m2, "MTN", { token: tok("MTN", { value: "RACT_Data_Flexi_Bundle", amount: 5 }) })).toMatchObject({ status: 409 })
  })
  it("amount equal at 2dp matches (string amount from Hubtel tolerated)", async () => {
    const m = make(); m.setQueryData([{ Display: "x", Value: BUNDLES.AT.value, Amount: "12.30" }])
    expect((await buy(m, "AT")).ok).toBe(true)
  })
  it("query error or throw => 503, nothing written", async () => {
    const m = make(); m.setQueryResult({ ok: false, error: "boom" })
    expect(await buy(m)).toMatchObject({ ok: false, status: 503 })
    expect(await buy(m, "MTN", {}, { ...m.d, query: async () => { throw new Error("net") } })).toMatchObject({ ok: false, status: 503 })
    expect(m.writes()).toBe(0)
  })
})

describe("Review Focus 2: double-click / retry => exactly one debit and one Hubtel POST", () => {
  it("sequential repeat with the same key returns the existing order (200) without re-checking or re-debiting", async () => {
    const m = make()
    const a = await buy(m)
    const b = await buy(m)
    expect(a.ok && b.ok).toBe(true)
    expect(b.ok && b.order.id).toBe("o1")
    expect([m.calls.insert, m.calls.debit, m.calls.purchase, m.calls.query]).toEqual([1, 1, 1, 1])
  })
  it("existing order is returned before any other check (even with a now-expired token)", async () => {
    const m = make()
    await buy(m)
    const r = await buy(m, "MTN", { token: "garbage", phone: "nope" })
    expect(r.ok && r.order.id).toBe("o1")
  })
  it("concurrent requests: the loser's unique violation returns the winner's order", async () => {
    const m = make()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const slow = { ...m.d, query: async (...a: Parameters<BundlesDeps["query"]>) => { await gate; return m.d.query(...a) } }
    const p1 = buy(m, "MTN", {}, slow)
    const p2 = buy(m, "MTN", {}, slow)
    await new Promise(r => setTimeout(r, 0))
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok && r2.ok).toBe(true)
    expect(r1.ok && r2.ok && r1.order.id === r2.order.id).toBe(true)
    expect(m.orders.length).toBe(1)
    expect([m.calls.debit, m.calls.purchase]).toEqual([1, 1])
  })
  it("different keys for the same user create separate orders", async () => {
    const m = make()
    await buy(m); await buy(m, "MTN", { idempotencyKey: "another-key-123" })
    expect(m.orders.length).toBe(2)
  })
  it("invalid key => 400, nothing looked up or written", async () => {
    const m = make()
    expect(await buy(m, "MTN", { idempotencyKey: "short" })).toMatchObject({ ok: false, status: 400 })
    expect(m.calls.find + m.writes() + m.calls.query).toBe(0)
  })
  it("idempotency lookup throws => 503 fail closed", async () => {
    const m = make()
    expect(await buy(m, "MTN", {}, { ...m.d, findOrderByIdempotencyKey: async () => { throw new Error("db") } })).toMatchObject({ ok: false, status: 503 })
    expect(m.writes()).toBe(0)
  })
  it("unique violation with no row found (e.g. reference collision) => 503 not charged, no debit", async () => {
    const m = make()
    const d = { ...m.d, insertOrder: async () => { throw Object.assign(new Error("dup"), { code: "23505" }) } }
    expect(await buy(m, "MTN", {}, d)).toMatchObject({ ok: false, status: 503, error: expect.stringMatching(/not charged/) })
    expect(m.calls.debit).toBe(0)
  })
  it("M6b: a non-23505 insert error => 503 (pre-payment), no debit, no purchase", async () => {
    const m = make()
    const d = { ...m.d, insertOrder: async () => { throw Object.assign(new Error("timeout"), { code: "57014" }) } }
    const r = await buy(m, "MTN", {}, d)
    expect(r).toMatchObject({ ok: false, status: 503 })
    expect(!r.ok && r.order).toBeFalsy()
    expect([m.calls.debit, m.calls.purchase]).toEqual([0, 0])
  })
})

describe("I1: replay with the same key", () => {
  it("pending + unpaid (debit rolled back) => RESUMES: debits once more, claims and dispatches", async () => {
    const m = make(); m.setWallet("throw_unpaid")
    expect(await buy(m)).toMatchObject({ ok: false, status: 500 })
    expect(m.orders[0]).toMatchObject({ status: "pending", payment_status: "unpaid" })
    m.setWallet("ok")
    // The retry carries the same key; the token may even have expired by now.
    const r = await buy(m, "MTN", { token: "garbage" })
    expect(r.ok && r.order).toMatchObject({ id: "o1", status: "processing", payment_status: "paid", hubtel_client_reference: "CR1" })
    expect([m.orders.length, m.calls.insert, m.calls.debit, m.calls.purchase]).toEqual([1, 1, 2, 1])
    expect(m.calls.query).toBe(1) // no re-query on resume
  })
  it("pending + unpaid resume with insufficient balance => 402, order failed, no purchase", async () => {
    const m = make(); m.setWallet("throw_unpaid")
    await buy(m)
    m.setWallet("insufficient")
    expect(await buy(m)).toMatchObject({ ok: false, status: 402, error: "Insufficient wallet balance", order: { status: "failed", payment_status: "unpaid" } })
    expect(m.orders[0]).toMatchObject({ status: "failed", failure_reason: "Insufficient wallet balance" })
    expect(m.calls.purchase).toBe(0)
  })
  it("pending + unpaid resume whose debit throws again (DB still unpaid) => 500 unconfirmed again, no purchase", async () => {
    const m = make(); m.setWallet("throw_unpaid")
    await buy(m)
    expect(await buy(m)).toMatchObject({ ok: false, status: 500, order: { id: "o1" } })
    expect([m.calls.debit, m.calls.purchase]).toEqual([2, 0])
  })
  it("pending + unpaid resume is refused (503, no debit) while Hubtel is paused / service off / bundles off", async () => {
    const m = make(); m.setWallet("throw_unpaid")
    await buy(m)
    m.setWallet("ok")
    m.hub.paused = true
    expect(await buy(m)).toMatchObject({ ok: false, status: 503 })
    m.hub.paused = false; m.hub.services.data_mtn = false
    expect(await buy(m)).toMatchObject({ ok: false, status: 503 })
    m.hub.services.data_mtn = true; m.cfg.networks.MTN.enabled = false
    expect(await buy(m)).toMatchObject({ ok: false, status: 503 })
    m.cfg.networks.MTN.enabled = true
    expect(await buy(m, "MTN", {}, { ...m.d, getHubtelConfig: async () => { throw new Error("db") } })).toMatchObject({ ok: false, status: 503 })
    expect(m.calls.debit).toBe(1)
    expect(m.orders[0]).toMatchObject({ status: "pending", payment_status: "unpaid" })
    expect((await buy(m)).ok).toBe(true)
    expect([m.calls.debit, m.calls.purchase]).toEqual([2, 1])
  })
  it("failed + unpaid (insufficient earlier) => 402 'Insufficient wallet balance' with the order, no debit", async () => {
    const m = make(); m.setWallet("insufficient")
    await buy(m)
    m.setWallet("ok")
    const r = await buy(m)
    expect(r).toMatchObject({ ok: false, status: 402, error: "Insufficient wallet balance", order: { id: "o1", status: "failed", payment_status: "unpaid" } })
    expect([m.calls.debit, m.calls.purchase]).toEqual([1, 0])
  })
  it("paid orders (any status) are returned as they are, never re-debited", async () => {
    const m = make()
    await buy(m)
    for (const s of ["processing", "completed", "failed", "pending"] as const) {
      m.orders[0].status = s
      const r = await buy(m)
      expect(r.ok && r.order).toMatchObject({ id: "o1", status: s, payment_status: "paid" })
    }
    expect([m.calls.debit, m.calls.purchase]).toEqual([1, 1])
  })
  it("a resume that loses the debit race (not_found, row already paid) returns the paid order without dispatching", async () => {
    const m = make(); m.setWallet("throw_unpaid")
    await buy(m)
    const d: BundlesDeps = {
      ...m.d,
      debitOrder: async () => { m.calls.debit++; m.orders[0].payment_status = "paid"; m.orders[0].status = "processing"; return "not_found" },
    }
    const r = await buy(m, "MTN", {}, d)
    expect(r.ok && r.order).toMatchObject({ id: "o1", payment_status: "paid", status: "processing" })
    expect(m.calls.purchase).toBe(0)
  })
})

describe("Review Focus 3: debit ok but Hubtel errored before the POST", () => {
  it("order pending+paid 'Not sent: …', alert, never resent", async () => {
    const m = make()
    let n = 0
    const d = { ...m.d, purchase: async () => { n++; throw new HubtelPausedError(null) } }
    const r = await buy(m, "MTN", {}, d)
    expect(r.ok && r.order).toMatchObject({ status: "pending", payment_status: "paid" })
    expect(m.orders[0]).toMatchObject({ status: "pending", payment_status: "paid" })
    expect(m.orders[0].notes).toMatch(/^Not sent: /)
    expect(m.calls.alerts.length).toBe(1)
    // A retry with the same key returns the order; it does not resend.
    const again = await buy(m, "MTN", {}, d)
    expect(again.ok && again.order.status).toBe("pending")
    expect(n).toBe(1)
  })
  it("Not-sent revert is guarded; no alert when 0 rows matched", async () => {
    const m = make()
    const d: BundlesDeps = {
      ...m.d,
      purchase: async () => { throw new HubtelPausedError(null) },
      updateOrder: async (id, patch, only) => {
        if ((patch as any).status === "pending" && only?.includes("processing")) { m.orders[0].status = "failed"; return 0 }
        return m.d.updateOrder(id, patch, only)
      },
    }
    await buy(m, "MTN", {}, d)
    expect(m.calls.alerts.length).toBe(0)
  })
})

describe("Review Focus 4: Telecel spaced value reaches Hubtel byte-for-byte", () => {
  it("leading/trailing spaces preserved in order row and purchase", async () => {
    const m = make()
    const r = await buy(m, "TELECEL")
    expect(r.ok).toBe(true)
    expect(m.orders[0].bundle_value).toBe(" 5.7 GB ")
    expect(m.calls.purchaseInputs[0].bundle).toBe(" 5.7 GB ")
    expect(m.calls.purchaseInputs[0].serviceKey).toBe("data_telecel")
  })
})

describe("Review Focus 5 (catalog side) — category gate at buy time", () => {
  it("hidden category => 403, nothing written", async () => {
    const m = make(); m.cfg.networks.MTN.hiddenCategories = ["Data"]
    expect(await buy(m)).toMatchObject({ ok: false, status: 403 })
    expect(m.writes() + m.calls.query).toBe(0)
  })
})

describe("pre-checks before any write", () => {
  it("Hubtel paused => 503 with no write and no query", async () => {
    const m = make(); m.hub.paused = true
    expect(await buy(m)).toMatchObject({ ok: false, status: 503 })
    expect(m.writes() + m.calls.query).toBe(0)
  })
  it("Hubtel disabled / service off / config throws => 503", async () => {
    const m = make()
    m.hub.enabled = false
    expect(await buy(m)).toMatchObject({ ok: false, status: 503 })
    m.hub.enabled = true; m.hub.services.data_mtn = false
    expect(await buy(m)).toMatchObject({ ok: false, status: 503 })
    m.hub.services.data_mtn = true
    expect(await buy(m, "MTN", {}, { ...m.d, getHubtelConfig: async () => { throw new Error("db") } })).toMatchObject({ ok: false, status: 503 })
    expect(await buy(m, "MTN", {}, { ...m.d, getBundlesConfig: async () => { throw new Error("db") } })).toMatchObject({ ok: false, status: 503 })
    expect(m.writes() + m.calls.query).toBe(0)
  })
  it("bundles master off / network off => 403", async () => {
    const m = make(); m.cfg.enabled = false
    expect(await buy(m)).toMatchObject({ ok: false, status: 403 })
    m.cfg.enabled = true; m.cfg.networks.MTN.enabled = false
    expect(await buy(m)).toMatchObject({ ok: false, status: 403 })
    expect(m.writes() + m.calls.query).toBe(0)
  })
  it("empty secret => 503; bad / expired / foreign tokens => 409 'Prices refreshed' (the UI reloads the catalog)", async () => {
    const m = make()
    expect(await buy(m, "MTN", {}, { ...m.d, secret: "" })).toMatchObject({ ok: false, status: 503 })
    const t = tok()
    for (const bad of [t + "x", "garbage", signBundleToken({ network: "MTN", ...BUNDLES.MTN, issuedAt: T0 }, "other-secret")]) {
      expect(await buy(m, "MTN", { token: bad })).toEqual({ ok: false, status: 409, error: PRICES_REFRESHED })
    }
    expect(await buy(m, "MTN", {}, { ...m.d, now: () => T0 + 11 * 60_000 })).toEqual({ ok: false, status: 409, error: PRICES_REFRESHED })
    expect(m.writes() + m.calls.query).toBe(0)
  })
  it("invalid phone => 400", async () => {
    const m = make()
    for (const p of ["", "0123456789", "02441234", "abc"]) expect(await buy(m, "MTN", { phone: p })).toMatchObject({ ok: false, status: 400 })
    expect(m.writes() + m.calls.query).toBe(0)
  })
  it("network prefix mismatch => 400 for each network", async () => {
    const m = make()
    expect(await buy(m, "MTN", { phone: PHONES.TELECEL })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/Telecel/) })
    expect(await buy(m, "TELECEL", { phone: PHONES.AT })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/AT/) })
    expect(await buy(m, "AT", { phone: PHONES.MTN })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/MTN/) })
    expect(m.writes() + m.calls.query).toBe(0)
  })
  it("uses the admin-editable prefix map", async () => {
    const m = make()
    m.prefix.map = { ...DEFAULT_NETWORK_PREFIXES, MTN: [...DEFAULT_NETWORK_PREFIXES.MTN, "58"] }
    expect((await buy(m, "MTN", { phone: "0581234567" })).ok).toBe(true)
  })
  it("prefix validation toggled off skips the mismatch block; a failed read validates with defaults", async () => {
    const m = make(); m.prefix.enabled = false
    expect((await buy(m, "MTN", { phone: PHONES.TELECEL })).ok).toBe(true)
    const m2 = make()
    expect(await buy(m2, "MTN", { phone: PHONES.TELECEL }, { ...m2.d, getPrefixConfig: async () => { throw new Error("db") } })).toMatchObject({ ok: false, status: 400 })
  })
})

describe("debit outcomes", () => {
  it("insufficient balance => 402, order failed, no purchase", async () => {
    const m = make(); m.setWallet("insufficient")
    expect(await buy(m)).toMatchObject({ ok: false, status: 402, error: "Insufficient wallet balance" })
    expect(m.orders[0]).toMatchObject({ status: "failed", payment_status: "unpaid", failure_reason: "Insufficient wallet balance" })
    expect([m.calls.debit, m.calls.purchase]).toEqual([1, 0])
  })
  it("not_found => 409, no purchase", async () => {
    const m = make(); m.setWallet("not_found")
    expect(await buy(m)).toMatchObject({ ok: false, status: 409 })
    expect(m.calls.purchase).toBe(0)
  })
  it("debit throws but DB says paid => continues and dispatches", async () => {
    const m = make(); m.setWallet("throw_paid")
    const r = await buy(m)
    expect(r.ok && r.order).toMatchObject({ payment_status: "paid", status: "processing" })
    expect(m.calls.purchase).toBe(1)
  })
  it("debit throws and DB unpaid => urgent 'debit outcome uncertain' alert + 500, no purchase", async () => {
    const m = make(); m.setWallet("throw_unpaid")
    expect(await buy(m)).toMatchObject({ ok: false, status: 500 })
    expect(m.orders[0]).toMatchObject({ status: "pending", payment_status: "unpaid" })
    expect(m.calls.alerts.join()).toMatch(/debit outcome uncertain/)
    expect(m.calls.urgent).toContain(true)
    expect(m.calls.purchase).toBe(0)
  })
  it("M6a: debit throws AND the re-read throws => urgent alert + 500 with the order, no purchase", async () => {
    const m = make(); m.setWallet("throw_unpaid")
    const r = await buy(m, "MTN", {}, { ...m.d, getOrder: async () => { throw new Error("db") } })
    expect(r).toMatchObject({ ok: false, status: 500, order: { id: "o1" } })
    expect(m.calls.alerts.join()).toMatch(/debit outcome uncertain/)
    expect(m.calls.urgent).toContain(true)
    expect(m.calls.purchase).toBe(0)
  })
  it("R1: insufficient never marks an order failed once a concurrent resume has paid it", async () => {
    const m = make(); m.setWallet("insufficient")
    const d: BundlesDeps = {
      ...m.d,
      debitOrder: async (id) => { m.orders.find(x => x.id === id)!.payment_status = "paid"; return "insufficient" },
    }
    await buy(m, "MTN", {}, d)
    expect(m.orders[0]).toMatchObject({ status: "pending", payment_status: "paid" })
  })
  it("M6c: marking the order failed after insufficient rejects => swallowed, still 402, no purchase", async () => {
    const m = make(); m.setWallet("insufficient")
    const d: BundlesDeps = { ...m.d, updateOrder: async () => { throw new Error("db") } }
    expect(await buy(m, "MTN", {}, d)).toMatchObject({ ok: false, status: 402, error: "Insufficient wallet balance", order: { status: "failed" } })
    expect(m.calls.purchase).toBe(0)
  })
})

describe("dispatch outcomes", () => {
  it("claim lost => no purchase", async () => {
    const m = make()
    const d: BundlesDeps = {
      ...m.d,
      updateOrder: async (id, patch, only) => {
        if ((patch as any).status === "processing") { m.orders[0].status = "processing"; return 0 } // someone else claimed it
        return m.d.updateOrder(id, patch, only)
      },
    }
    const r = await buy(m, "MTN", {}, d)
    expect(r.ok).toBe(true)
    expect(m.calls.purchase).toBe(0)
  })
  it("stale re-read (order no longer pending) => no purchase", async () => {
    const m = make()
    const d = { ...m.d, getOrder: async (id: string) => { const o = await m.d.getOrder(id); return o ? { ...o, status: "refunded" as const } : null } }
    const r = await buy(m, "MTN", {}, d)
    expect(r.ok && r.order.status).toBe("refunded")
    expect(m.calls.purchase).toBe(0)
  })
  it("re-read throws before dispatch => alert, no purchase", async () => {
    const m = make()
    const r = await buy(m, "MTN", {}, { ...m.d, getOrder: async () => { throw new Error("db") } })
    expect(r.ok && r.order.status).toBe("pending")
    expect(m.calls.alerts.length).toBe(1)
    expect(m.calls.purchase).toBe(0)
  })
  it("OutcomeUnknown => processing + ref note + alert", async () => {
    const m = make()
    const r = await buy(m, "MTN", {}, { ...m.d, purchase: async () => { throw new HubtelOutcomeUnknownError("CRX", new Error("x")) } })
    expect(r.ok && r.order.status).toBe("processing")
    expect(m.orders[0]).toMatchObject({ status: "processing", hubtel_client_reference: "CRX" })
    expect(m.orders[0].notes).toMatch(/do not resend/)
    expect(m.calls.alerts.length).toBe(1)
  })
  it("needs_review => processing + ref + alert", async () => {
    const m = make(); m.setTxState("needs_review")
    const r = await buy(m)
    expect(r.ok && r.order.status).toBe("processing")
    expect(m.orders[0]).toMatchObject({ hubtel_client_reference: "CR1" })
    expect(m.orders[0].notes).toMatch(/Outcome unknown/)
    expect(m.calls.alerts.length).toBe(1)
  })
  it("Duplicate order error => processing + note + alert", async () => {
    const m = make()
    const r = await buy(m, "MTN", {}, { ...m.d, purchase: async () => { throw new HubtelDuplicateOrderError("hubtel_data_orders", "o1") } })
    expect(r.ok && r.order.status).toBe("processing")
    expect(m.orders[0].notes).toMatch(/do not resend/)
    expect(m.calls.alerts.join()).toMatch(/do not resend/)
  })
  it("0-row ref write: returns real status, no alert when a callback settled it", async () => {
    const m = make()
    const d = { ...m.d, purchase: async () => { m.orders[0].status = "completed"; return { client_reference: "CR1", state: "pending" } as HubtelCsTx } }
    const r = await buy(m, "MTN", {}, d)
    expect(r.ok && r.order.status).toBe("completed")
    expect(m.calls.alerts).toEqual([])
  })
  it("0-row ref write alerts when still processing without a ref", async () => {
    const m = make()
    const d: BundlesDeps = { ...m.d, updateOrder: async (id, p, only) => (p.hubtel_client_reference ? 0 : m.d.updateOrder(id, p, only)) }
    const r = await buy(m, "MTN", {}, d)
    expect(r.ok && r.order.status).toBe("processing")
    expect(m.calls.alerts.some(a => a.includes("could not be updated"))).toBe(true)
  })
})

describe("buyBundle — instant cashback", () => {
  // data_mtn at 4% commission; bundles customer share 50%, dealer 75%. MTN bundle GHS 10 => commission 0.40.
  const CB = (over: Record<string, unknown> = {}) => resolveCashbackConfig({
    enabled: true,
    surfaces: { dashboard: true },
    rates: { "data_mtn:hubtel": 4 },
    shares: { bundles: { customer: 50, dealer: 75, storefrontCustomer: 0, storefrontShop: 0 } },
    ...over,
  })

  it("applied (customer): wallet debited 9.80, order amount 10 (face), Hubtel receives 10, snapshot columns set", async () => {
    const m = make(); m.setCashback(CB())
    const r = await buy(m)
    expect(r.ok).toBe(true)
    expect(m.calls.debitAmounts).toEqual([9.8])
    expect(m.calls.purchaseInputs[0]).toMatchObject({ serviceKey: "data_mtn", amount: 10 })
    expect(m.orders[0]).toMatchObject({
      amount: 10, paid_amount: 9.8, cashback_amount: 0.2, shop_share_amount: 0, cashback_rate: 4, cashback_share: 50,
      cashback_provider: "hubtel", expected_commission: 0.4,
    })
  })
  it("applied (dealer tier): debits 9.70", async () => {
    const m = make(); m.setCashback(CB()); m.setTier("dealer")
    await buy(m)
    expect(m.calls.debitAmounts).toEqual([9.7])
    expect(m.orders[0]).toMatchObject({ amount: 10, paid_amount: 9.7, cashback_amount: 0.3, cashback_share: 75 })
  })
  it("expectedPay matching the quote proceeds", async () => {
    const m = make(); m.setCashback(CB())
    expect((await buy(m, "MTN", { expectedPay: 9.8 })).ok).toBe(true)
    expect(m.calls.debitAmounts).toEqual([9.8])
  })
  it("expectedPay mismatch => 409 'Price updated' with the quote, nothing written (key stays usable)", async () => {
    const m = make(); m.setCashback(CB())
    expect(await buy(m, "MTN", { expectedPay: 10 })).toEqual({
      ok: false, status: 409, error: "Price updated — please review",
      quote: { faceAmount: 10, payAmount: 9.8, customerCashback: 0.2 },
    })
    expect(m.writes()).toBe(0)
    expect(m.orders.length).toBe(0)
    expect((await buy(m, "MTN", { expectedPay: 9.8 })).ok).toBe(true)
  })
  it("expectedPay mismatch while not applied => 409 quoted at face", async () => {
    const m = make()
    expect(await buy(m, "MTN", { expectedPay: 9.8 })).toMatchObject({
      ok: false, status: 409, quote: { faceAmount: 10, payAmount: 10, customerCashback: 0 },
    })
    expect(m.writes()).toBe(0)
  })
  it("pre-checks still win: bundle not offered for the number => 409 NOT_AVAILABLE, no quote", async () => {
    const m = make(); m.setCashback(CB())
    m.setQueryData([{ Display: "x", Value: "other", Amount: 10 }])
    expect(await buy(m, "MTN", { expectedPay: 1 })).toEqual({ ok: false, status: 409, error: NOT_AVAILABLE_FOR_NUMBER })
    expect(m.writes()).toBe(0)
  })
  it("not applied (master off / dashboard off / network without rate) => paid_amount null, debit = amount", async () => {
    const cases: [ReturnType<typeof CB>, BundleNetwork][] = [
      [CB({ enabled: false }), "MTN"], [CB({ surfaces: { dashboard: false, bots: true } }), "MTN"], [CB(), "AT"],
    ]
    for (const [cfg, n] of cases) {
      const m = make(); m.setCashback(cfg)
      expect((await buy(m, n)).ok).toBe(true)
      expect(m.orders[0].paid_amount).toBeNull()
      expect(m.orders[0]).not.toHaveProperty("cashback_amount")
      expect(m.calls.debitAmounts).toEqual([BUNDLES[n].amount])
      expect(m.calls.purchaseInputs[0].amount).toBe(BUNDLES[n].amount)
    }
  })
  it("config or tier read failure => not applied, purchase goes ahead at face", async () => {
    for (const over of [
      { getCashbackConfig: async () => { throw new Error("db") } },
      { getBuyerTier: async () => { throw new Error("db") } },
    ] as Partial<BundlesDeps>[]) {
      const m = make(over); m.setCashback(CB())
      expect((await buy(m)).ok).toBe(true)
      expect(m.orders[0].paid_amount).toBeNull()
      expect(m.calls.debitAmounts).toEqual([10])
    }
  })
  it("replay is never re-quoted: a resumed cashback order debits its stored paid_amount even after cashback is switched off", async () => {
    const m = make(); m.setCashback(CB()); m.setWallet("throw_unpaid")
    expect(await buy(m)).toMatchObject({ ok: false, status: 500 })
    expect(m.orders[0]).toMatchObject({ amount: 10, paid_amount: 9.8, payment_status: "unpaid" })
    m.setWallet("ok"); m.setCashback(CB({ enabled: false }))
    // A different expectedPay on the replay is ignored: the replay check runs first.
    const r = await buy(m, "MTN", { token: "garbage", expectedPay: 10 })
    expect(r.ok && r.order).toMatchObject({ id: "o1", payment_status: "paid", paid_amount: 9.8 })
    expect(m.calls.debitAmounts).toEqual([9.8])
    expect(m.calls.purchaseInputs[0].amount).toBe(10)
    expect([m.calls.insert, m.calls.purchase]).toEqual([1, 1])
  })
  it("a paid replay returns the stored order unchanged", async () => {
    const m = make(); m.setCashback(CB())
    await buy(m)
    const r = await buy(m, "MTN", { expectedPay: 1 })
    expect(r.ok && r.order).toMatchObject({ id: "o1", paid_amount: 9.8, cashback_amount: 0.2 })
    expect(m.calls.debitAmounts).toEqual([9.8])
  })
})

describe("buyBundle — api channel", () => {
  const CB = (surfaces: Record<string, boolean>) => resolveCashbackConfig({
    enabled: true, surfaces,
    rates: { "data_mtn:hubtel": 4 },
    shares: { bundles: { customer: 50, dealer: 75, storefrontCustomer: 0, storefrontShop: 0 } },
  })
  const apiBuy = (m: ReturnType<typeof make>, over: Partial<BuyInput> = {}, userId = "u1") =>
    buyBundle(m.d, userId, { token: tok("MTN"), phone: PHONES.MTN, idempotencyKey: KEY, channel: "api", ...over })

  it("default channel is dashboard", async () => {
    const m = make()
    expect((await buy(m)).ok).toBe(true)
    expect(m.orders[0]).toMatchObject({ channel: "dashboard", user_id: "u1" })
  })
  it("api surface off (dashboard on) => api wallet order at face, row channel 'api'", async () => {
    const m = make(); m.setCashback(CB({ dashboard: true, api: false }))
    const r = await apiBuy(m)
    expect(r.ok).toBe(true)
    expect(m.orders[0]).toMatchObject({ channel: "api", user_id: "u1", amount: 10, paid_amount: null })
    expect(m.orders[0]).not.toHaveProperty("cashback_amount")
    expect(m.calls.debitAmounts).toEqual([10])
  })
  it("api surface on => cashback with the buyer's tier (dealer 75%), Hubtel receives face", async () => {
    const m = make(); m.setCashback(CB({ api: true })); m.setTier("dealer")
    const r = await apiBuy(m, { expectedPay: 9.7 })
    expect(r.ok).toBe(true)
    expect(m.orders[0]).toMatchObject({ channel: "api", amount: 10, paid_amount: 9.7, cashback_amount: 0.3, cashback_share: 75 })
    expect(m.calls.debitAmounts).toEqual([9.7])
    expect(m.calls.purchaseInputs[0]).toMatchObject({ amount: 10 })
  })
  it("api surface on does not turn on dashboard pricing", async () => {
    const m = make(); m.setCashback(CB({ api: true }))
    await buy(m)
    expect(m.orders[0]).toMatchObject({ channel: "dashboard", paid_amount: null })
  })
  it("api expectedPay mismatch => 409 with the quote, nothing written", async () => {
    const m = make(); m.setCashback(CB({ api: true }))
    expect(await apiBuy(m, { expectedPay: 10 })).toEqual({
      ok: false, status: 409, error: "Price updated — please review",
      quote: { faceAmount: 10, payAmount: 9.8, customerCashback: 0.2 },
    })
    expect(m.writes()).toBe(0)
  })
  it("same idempotency key on api => one order, one debit", async () => {
    const m = make(); m.setCashback(CB({ api: true }))
    await apiBuy(m); const r = await apiBuy(m)
    expect(r.ok && r.order).toMatchObject({ id: "o1", channel: "api" })
    expect([m.calls.insert, m.calls.debitAmounts.length, m.calls.purchase]).toEqual([1, 1, 1])
  })
  it("rejects a storefront/unknown channel and a missing user before anything is written", async () => {
    const m = make()
    expect(await apiBuy(m, { channel: "storefront" as any })).toMatchObject({ ok: false, status: 400 })
    expect(await apiBuy(m, {}, "")).toMatchObject({ ok: false, status: 401 })
    expect(m.writes()).toBe(0)
  })
})
