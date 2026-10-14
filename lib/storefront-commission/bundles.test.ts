import { describe, it, expect, beforeEach } from "vitest"
import { resolveCashbackConfig } from "@/lib/cashback/config"
import { resolveBundlesConfig } from "@/lib/standard-bundles/config"
import { __resetCatalogCache } from "@/lib/standard-bundles/catalog"
import {
  initializeStorefrontBundle, storefrontCatalog, type StorefrontBundleInsert, type StorefrontBundleRow, type StorefrontBundlesDeps,
} from "./bundles"

const NOW = 1_700_000_000_000
const ITEMS = [
  { Value: "x_Data_1", Display: "Data 1GB", Amount: 10 },
  { Value: "x_Video_1", Display: "Video 1", Amount: 3 },
]

const CASHBACK = (over: Record<string, unknown> = {}) => resolveCashbackConfig({
  enabled: true,
  surfaces: { storefront: true },
  rates: { "data_mtn:hubtel": 3.96 },
  shares: { bundles: { customer: 0, dealer: 0, storefrontCustomer: 20, storefrontShop: 40 } },
  paymentFee: { bundles: 1.95 },
  storefrontGroups: { bundles: true },
  ...over,
})

function harness(over: Partial<StorefrontBundlesDeps> & { cashback?: any; hubtel?: any; bundles?: any; offered?: any[] } = {}) {
  const inserts: StorefrontBundleInsert[] = []
  const rows: (StorefrontBundleRow & { shop_id: string; idempotency_key: string })[] = []
  const queries: any[] = []
  const limits: string[] = []
  const d: StorefrontBundlesDeps = {
    getCashbackConfig: async () => over.cashback ?? CASHBACK(),
    getBuyerTier: async () => "customer",
    getBundlesConfig: async () => resolveBundlesConfig(over.bundles ?? { enabled: true, networks: { MTN: { enabled: true, hiddenCategories: [] } } }),
    getHubtelConfig: async () => over.hubtel ?? { enabled: true, paused: false, services: { data_mtn: true } },
    query: async (serviceKey, destination) => {
      queries.push({ serviceKey, destination })
      return { ok: true, data: (over.offered ?? ITEMS) as any }
    },
    purchase: async () => { throw new Error("never in initialize") },
    getPrefixConfig: async () => ({ enabled: true, map: { MTN: ["24", "54", "55", "59", "25", "53"], TELECEL: ["20", "50"], AT: ["26", "27", "56", "57"] } }),
    findOrderByIdempotencyKey: async () => { throw new Error("dashboard lookup must not be used") },
    insertOrder: async () => { throw new Error("dashboard insert must not be used") },
    getOrder: async () => null,
    updateOrder: async () => 0,
    debitOrder: async () => { throw new Error("never debits") },
    alert: async () => {},
    newReference: () => `SB-REF${rows.length + 1}`,
    secret: "s3cret",
    now: () => NOW,
    async findStorefrontOrder(shopId, key) {
      return rows.find(r => r.shop_id === shopId && r.idempotency_key === key) ?? null
    },
    async insertStorefrontOrder(row) {
      if (rows.some(r => r.shop_id === row.shop_id && r.idempotency_key === row.idempotency_key)) {
        throw Object.assign(new Error("dup"), { code: "23505" })
      }
      inserts.push(row)
      const saved = {
        id: `order-${rows.length + 1}`, reference_code: row.reference_code, amount: row.amount, paid_amount: row.paid_amount,
        payment_fee_amount: row.payment_fee_amount, cashback_amount: row.cashback_amount, shop_id: row.shop_id, idempotency_key: row.idempotency_key,
      }
      rows.push(saved)
      return saved
    },
    caps: { limit: async n => (limits.push(n), true), countPending: async () => 0, now: () => NOW },
    ...over,
  }
  return { d, inserts, rows, queries, limits }
}

async function tokenFor(d: StorefrontBundlesDeps, value = "x_Data_1") {
  const c = await storefrontCatalog(d, "MTN")
  if (!c.ok) throw new Error("catalog failed")
  return c.categories.flatMap(x => x.bundles).find(b => b.value === value)!.token
}

const BUYER = { customerName: "Ama", customerEmail: "ama@example.com", customerPhone: "0201234567" }
const KEY = "key-0001-abcd"

beforeEach(() => __resetCatalogCache())

describe("storefrontCatalog", () => {
  it("adds the storefront price to every bundle", async () => {
    const { d } = harness()
    const c = await storefrontCatalog(d, "MTN")
    expect(c.ok).toBe(true)
    const all = (c as any).categories.flatMap((x: any) => x.bundles)
    const data = all.find((b: any) => b.value === "x_Data_1")
    // 3.96 % at 20/40 + fee 1.95 on GHS 10 => base 9.93, fee 0.20, pay 10.13
    expect(data).toMatchObject({ amount: 10, payAmount: 10.13, customerCashback: 0.07, paymentFee: 0.2, token: expect.any(String) })
    expect(JSON.stringify(c)).not.toMatch(/shopShare|storefrontShop/)
  })

  it.each([
    ["group off", { cashback: CASHBACK({ storefrontGroups: { bundles: false } }) }, 403],
    ["bundles master off", { bundles: { enabled: false, networks: { MTN: { enabled: true, hiddenCategories: [] } } } }, 403],
    ["network off", { bundles: { enabled: true, networks: { MTN: { enabled: false, hiddenCategories: [] } } } }, 403],
    ["hubtel paused", { hubtel: { enabled: true, paused: true, services: { data_mtn: true } } }, 503],
  ])("%s => %i", async (_n, over, status) => {
    const { d } = harness(over as any)
    const c = await storefrontCatalog(d, "MTN")
    expect(c).toMatchObject({ ok: false, status })
    if (status === 403) expect((c as any).error).toBe("Not available")
  })
})

describe("initializeStorefrontBundle", () => {
  it("creates an unpaid storefront row with the raw idempotency key", async () => {
    const { d, inserts, queries } = harness()
    const token = await tokenFor(d)
    const r = await initializeStorefrontBundle(d, "shop-A", { token, phone: "0541234567", idempotencyKey: KEY, expectedPay: 10.13, ...BUYER })
    expect(r).toEqual({
      ok: true,
      value: { orderId: "order-1", reference: "SB-REF1", payAmount: 10.13, faceAmount: 10, customerCashback: 0.07, paymentFee: 0.2 },
    })
    // live re-query for the recipient
    expect(queries.at(-1)).toEqual({ serviceKey: "data_mtn", destination: "233541234567" })
    expect(inserts[0]).toEqual({
      reference_code: "SB-REF1", user_id: null, channel: "storefront", shop_id: "shop-A",
      network: "MTN", service_key: "data_mtn", beneficiary_phone: "233541234567",
      bundle_value: "x_Data_1", bundle_display: "Data 1GB", bundle_category: "Data",
      amount: 10, paid_amount: 10.13, payment_fee_amount: 0.2,
      status: "pending", payment_status: "unpaid", idempotency_key: KEY,
      buyer_name: "Ama", buyer_email: "ama@example.com", buyer_phone: "0201234567",
      cashback_amount: 0.07, shop_share_amount: 0.15, cashback_rate: 3.96, cashback_share: 20,
      cashback_provider: "hubtel", expected_commission: 0.396,
    })
  })

  it("same (shop, key) again => the existing order, no second row", async () => {
    const { d, inserts } = harness()
    const token = await tokenFor(d)
    const input = { token, phone: "0541234567", idempotencyKey: KEY, expectedPay: 10.13, ...BUYER }
    const a = await initializeStorefrontBundle(d, "shop-A", input)
    const b = await initializeStorefrontBundle(d, "shop-A", input)
    expect(b).toEqual(a)
    expect(inserts).toHaveLength(1)
    // a different shop with the same key is a different order
    const c = await initializeStorefrontBundle(d, "shop-B", input)
    expect(c.ok && c.value.orderId).toBe("order-2")
  })

  it("concurrent insert loses on 23505 => returns the winner", async () => {
    const { d, rows } = harness()
    const token = await tokenFor(d)
    const realFind = d.findStorefrontOrder
    let first = true
    d.findStorefrontOrder = async (s, k) => {
      if (first) { first = false; rows.push({ id: "winner", reference_code: "SB-W", amount: 10, paid_amount: 10.13, payment_fee_amount: 0.2, cashback_amount: 0.07, shop_id: s, idempotency_key: k }); return null }
      return realFind(s, k)
    }
    const r = await initializeStorefrontBundle(d, "shop-A", { token, phone: "0541234567", idempotencyKey: KEY, expectedPay: 10.13, ...BUYER })
    expect(r).toMatchObject({ ok: true, value: { orderId: "winner", reference: "SB-W" } })
  })

  it("expectedPay mismatch => 409 with quote, nothing written, no caps consumed", async () => {
    const { d, inserts, limits } = harness()
    const token = await tokenFor(d)
    const r = await initializeStorefrontBundle(d, "shop-A", { token, phone: "0541234567", idempotencyKey: KEY, expectedPay: 10, ...BUYER })
    expect(r).toEqual({
      ok: false, status: 409, error: "Price updated — please review",
      quote: { faceAmount: 10, payAmount: 10.13, customerCashback: 0.07, paymentFee: 0.2 },
    })
    expect(inserts).toHaveLength(0)
    expect(limits).toHaveLength(0)
  })

  it("bad token => 409 prices refreshed; bad key => 400", async () => {
    const { d } = harness()
    expect(await initializeStorefrontBundle(d, "shop-A", { token: "x.y", phone: "0541234567", idempotencyKey: KEY, expectedPay: 1, ...BUYER }))
      .toMatchObject({ status: 409 })
    expect(await initializeStorefrontBundle(d, "shop-A", { token: "x.y", phone: "0541234567", idempotencyKey: "bad key", expectedPay: 1, ...BUYER }))
      .toMatchObject({ status: 400 })
  })

  it("no longer offered for the recipient => 409; wrong network prefix => 400", async () => {
    const h = harness()
    const token = await tokenFor(h.d)
    const gone = harness({ offered: [{ Value: "x_Data_1", Display: "Data 1GB", Amount: 12 }] })
    expect(await initializeStorefrontBundle(gone.d, "shop-A", { token, phone: "0541234567", idempotencyKey: KEY, expectedPay: 10.13, ...BUYER }))
      .toMatchObject({ status: 409 })
    expect(gone.inserts).toHaveLength(0)
    expect(await initializeStorefrontBundle(h.d, "shop-A", { token, phone: "0201234567", idempotencyKey: KEY, expectedPay: 10.13, ...BUYER }))
      .toMatchObject({ status: 400 })
  })

  it("switches off / hidden category / paused => 403/503, nothing written", async () => {
    const base = harness()
    const token = await tokenFor(base.d)
    for (const [over, status] of [
      [{ cashback: CASHBACK({ storefrontGroups: { bundles: false } }) }, 403],
      [{ bundles: { enabled: true, networks: { MTN: { enabled: true, hiddenCategories: ["Data"] } } } }, 403],
      [{ hubtel: { enabled: true, paused: true, services: { data_mtn: true } } }, 503],
    ] as const) {
      const h = harness(over as any)
      const r = await initializeStorefrontBundle(h.d, "shop-A", { token, phone: "0541234567", idempotencyKey: KEY, expectedPay: 10.13, ...BUYER })
      expect(r).toMatchObject({ ok: false, status })
      if (status === 403) expect((r as any).error).toBe("Not available")
      expect(h.inserts).toHaveLength(0)
    }
  })

  it("pending caps => 429, nothing written", async () => {
    const { d, inserts } = harness()
    d.caps.limit = async n => !n.endsWith("_1h")
    const token = await tokenFor(d)
    expect(await initializeStorefrontBundle(d, "shop-A", { token, phone: "0541234567", idempotencyKey: KEY, expectedPay: 10.13, ...BUYER }))
      .toMatchObject({ status: 429 })
    expect(inserts).toHaveLength(0)
  })
})
