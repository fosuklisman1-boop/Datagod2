import { describe, it, expect } from "vitest"
import { resolveCashbackConfig } from "@/lib/cashback/config"
import { resolveBillsConfig } from "@/lib/bills/config"
import { billTokenHash } from "@/lib/bills/service"
import {
  initializeStorefrontBill, shopBinding, verifyStorefrontBill,
  type StorefrontBillInsert, type StorefrontBillsDeps, type StorefrontOrderRow,
} from "./bills"

const NOW = 1_700_000_000_000

const CASHBACK = (over: Record<string, unknown> = {}) => resolveCashbackConfig({
  enabled: true,
  surfaces: { storefront: true },
  rates: { "bill_dstv:hubtel": 0.69 },
  shares: { bills: { customer: 0, dealer: 0, storefrontCustomer: 20, storefrontShop: 40 } },
  paymentFee: { bills: 1.95 },
  storefrontGroups: { bills: true },
  ...over,
})

function harness(over: Partial<StorefrontBillsDeps> & { cashback?: ReturnType<typeof CASHBACK>; hubtel?: any; bills?: any } = {}) {
  const inserts: StorefrontBillInsert[] = []
  const queries: any[] = []
  const limits: string[] = []
  const saved: (StorefrontOrderRow & { shop_id: string; verify_token_hash: string })[] = []
  let refs = 0
  const d: StorefrontBillsDeps = {
    getCashbackConfig: async () => over.cashback ?? CASHBACK(),
    getBuyerTier: async () => "customer",
    getBillsConfig: async () => resolveBillsConfig(over.bills ?? { enabled: true, billers: { dstv: { enabled: true, min: 5, max: 1000 } } }),
    getHubtelConfig: async () => over.hubtel ?? { enabled: true, paused: false, services: { bill_dstv: true } },
    query: async (serviceKey, destination) => {
      queries.push({ serviceKey, destination })
      return { ok: true, data: [{ Display: "name", Value: "JOHN DOE" }, { Display: "amountDue", Value: "80" }] as any }
    },
    purchase: async () => { throw new Error("never in initialize") },
    insertOrder: async () => { throw new Error("dashboard insert must not be used") },
    getOrder: async () => null,
    updateOrder: async () => 0,
    debitOrder: async () => { throw new Error("never debits") },
    alert: async () => {},
    newReference: () => (refs++ === 0 ? "BILL-ABC123" : `BILL-ALT${refs}`),
    secret: "s3cret",
    now: () => NOW,
    async insertStorefrontOrder(row) {
      if (saved.some(s => s.verify_token_hash === row.verify_token_hash || s.reference_code === row.reference_code)) {
        throw Object.assign(new Error("dup"), { code: "23505" })
      }
      inserts.push(row)
      const s = {
        id: `order-${inserts.length}`, reference_code: row.reference_code, amount: row.amount, paid_amount: row.paid_amount,
        payment_fee_amount: row.payment_fee_amount, cashback_amount: row.cashback_amount,
        shop_id: row.shop_id, verify_token_hash: row.verify_token_hash,
      }
      saved.push(s)
      return s
    },
    async findStorefrontOrderByHash(shopId, hash) {
      return saved.find(s => s.shop_id === shopId && s.verify_token_hash === hash) ?? null
    },
    caps: {
      limit: async name => (limits.push(name), true),
      countPending: async () => 0,
      now: () => NOW,
    },
    ...over,
  }
  return { d, inserts, queries, limits, saved }
}

async function tokenFor(d: StorefrontBillsDeps, shopId = "shop-A") {
  const r = await verifyStorefrontBill(d, shopId, "dstv", { account: "1234567890" })
  if (!r.ok || !r.token) throw new Error("verify failed: " + JSON.stringify(r))
  return r.token
}

const BUYER = { customerName: "Ama", customerEmail: "ama@example.com", customerPhone: "0241234567" }

describe("verifyStorefrontBill", () => {
  it("verifies through the engine with a shop-bound token", async () => {
    const { d, queries } = harness()
    const r = await verifyStorefrontBill(d, "shop-A", "dstv", { account: "1234567890" })
    expect(r).toMatchObject({ ok: true, customerName: "JOH*** D***", amountDue: 80, suggestedAmount: 80 })
    expect(queries).toEqual([{ serviceKey: "bill_dstv", destination: "1234567890" }])
    const body = JSON.parse(Buffer.from((r as any).token.split(".")[0], "base64url").toString())
    expect(body.userId).toBe(shopBinding("shop-A"))
    // the readable token body carries only the masked name
    expect(body.customerName).toBe("JOH*** D***")
    expect(JSON.stringify(r)).not.toContain("JOHN")
  })

  it("ECG meter names are masked, outstanding amounts stay, meter tokens masked", async () => {
    const { d } = harness({
      bills: { enabled: true, billers: { ecg: { enabled: true, min: 5, max: 1000 } } },
      hubtel: { enabled: true, paused: false, services: { bill_ecg: true } },
      query: async () => ({ ok: true, data: [{ Display: "KLINSMAN FOSU BOATENG (Prepaid)", Value: "P123456", Amount: 12.5 }] as any }),
    })
    const r: any = await verifyStorefrontBill(d, "shop-A", "ecg", { phone: "0241234567" })
    expect(r.ok).toBe(true)
    expect(r.meters).toEqual([{ meter: "P123456", name: "KLI*** FOS*** BOA***", outstanding: 12.5, token: expect.any(String) }])
    const body = JSON.parse(Buffer.from(r.meters[0].token.split(".")[0], "base64url").toString())
    expect(body.customerName).toBe("KLI*** FOS*** BOA***")
    expect(JSON.stringify(r)).not.toContain("KLINSMAN")
  })

  it("lookup failures carry fixed text, never provider detail", async () => {
    const rejected = harness({ query: async () => ({ ok: false, error: "Hubtel code 4075: Invalid smartcard" }) })
    expect(await verifyStorefrontBill(rejected.d, "shop-A", "dstv", { account: "1234567890" }))
      .toEqual({ ok: false, status: 422, error: "Couldn't verify this account" })
    const threw = harness({ query: async () => { throw new Error("fetch failed ETIMEDOUT hubtel") } })
    expect(await verifyStorefrontBill(threw.d, "shop-A", "dstv", { account: "1234567890" }))
      .toEqual({ ok: false, status: 422, error: "Couldn't verify this account right now" })
  })

  it.each([
    ["storefront group off", { cashback: CASHBACK({ storefrontGroups: { bills: false } }) }, 403],
    ["storefront surface off", { cashback: CASHBACK({ surfaces: { storefront: false } }) }, 403],
    ["cashback master off", { cashback: CASHBACK({ enabled: false }) }, 403],
    ["bills master off", { bills: { enabled: false, billers: { dstv: { enabled: true, min: 5, max: 1000 } } } }, 403],
    ["biller off", { bills: { enabled: true, billers: { dstv: { enabled: false, min: 5, max: 1000 } } } }, 403],
    ["hubtel paused", { hubtel: { enabled: true, paused: true, services: { bill_dstv: true } } }, 503],
    ["hubtel service off", { hubtel: { enabled: true, paused: false, services: { bill_dstv: false } } }, 503],
  ])("%s => %i, no Hubtel query", async (_n, over, status) => {
    const { d, queries } = harness(over as any)
    const r = await verifyStorefrontBill(d, "shop-A", "dstv", { account: "1234567890" })
    expect(r).toMatchObject({ ok: false, status })
    if (status === 403) expect((r as any).error).toBe("Not available")
    expect(queries).toHaveLength(0)
  })

  it("unknown biller => 400", async () => {
    const { d } = harness()
    expect(await verifyStorefrontBill(d, "shop-A", "nope", {})).toMatchObject({ ok: false, status: 400 })
  })
})

describe("initializeStorefrontBill", () => {
  it("creates an unpaid storefront row: face to Hubtel, pay incl. fee, buyer_* and snapshot", async () => {
    const { d, inserts, limits } = harness()
    const token = await tokenFor(d)
    // DSTV 0.69 %, storefront 20/40, fee 1.95 on GHS 100 => customer 0.13, shop 0.27, base 99.87, fee 1.95, pay 101.82
    const r = await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: 101.82, ...BUYER })
    expect(r).toEqual({
      ok: true,
      value: { orderId: "order-1", reference: "BILL-ABC123", payAmount: 101.82, faceAmount: 100, customerCashback: 0.13, paymentFee: 1.95 },
    })
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toEqual({
      reference_code: "BILL-ABC123", user_id: null, channel: "storefront", shop_id: "shop-A",
      biller: "dstv", account_number: "1234567890", phone: null, email: null, broadband_account: null,
      session_id: null, customer_name: "JOH*** D***", verified: true,
      amount: 100, paid_amount: 101.82, payment_fee_amount: 1.95,
      status: "pending", payment_status: "unpaid",
      buyer_name: "Ama", buyer_email: "ama@example.com", buyer_phone: "0241234567",
      cashback_amount: 0.13, shop_share_amount: 0.27, cashback_rate: 0.69, cashback_share: 20,
      cashback_provider: "hubtel", expected_commission: 0.69,
      verify_token_hash: billTokenHash(token),
    })
    expect(limits).toHaveLength(4)
  })

  it("a token from another shop does not initialize here", async () => {
    const { d, inserts } = harness()
    const token = await tokenFor(d, "shop-A")
    const r = await initializeStorefrontBill(d, "shop-B", { token, amount: 100, expectedPay: 101.82, ...BUYER })
    expect(r).toMatchObject({ ok: false, status: 400, error: "Please verify the account again" })
    expect(inserts).toHaveLength(0)
  })

  it("a dashboard (user-bound) token does not initialize at a shop", async () => {
    const { d } = harness()
    const { verifyBill } = await import("@/lib/bills/service")
    const r = await verifyBill(d, "shop-A-is-not-a-user", "dstv", { account: "1234567890" })
    const token = (r as any).token
    expect(await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: 101.82, ...BUYER }))
      .toMatchObject({ ok: false, status: 400 })
  })

  it("expectedPay mismatch => 409 with the live quote, nothing written, no caps consumed", async () => {
    const { d, inserts, limits } = harness()
    const token = await tokenFor(d)
    const r = await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: 99.87, ...BUYER })
    expect(r).toEqual({
      ok: false, status: 409, error: "Price updated — please review",
      quote: { faceAmount: 100, payAmount: 101.82, customerCashback: 0.13, paymentFee: 1.95 },
    })
    expect(inserts).toHaveLength(0)
    expect(limits).toHaveLength(0)
  })

  it("non-numeric expectedPay => 409; missing => 400", async () => {
    const { d } = harness()
    const token = await tokenFor(d)
    expect(await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: "abc", ...BUYER })).toMatchObject({ status: 409 })
    expect(await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: undefined, ...BUYER })).toMatchObject({ status: 400 })
  })

  it("the token makes one order: a double submit returns that same order", async () => {
    const { d, inserts } = harness()
    const token = await tokenFor(d)
    const first = await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: 101.82, ...BUYER })
    expect(first.ok).toBe(true)
    const again = await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: 101.82, ...BUYER })
    expect(again).toEqual(first)
    expect(inserts).toHaveLength(1)
  })

  it("a reference collision retries once with a fresh reference", async () => {
    const { d, saved, inserts } = harness()
    saved.push({ id: "old", reference_code: "BILL-ABC123", amount: 5, paid_amount: 5, payment_fee_amount: 0, cashback_amount: 0, shop_id: "other", verify_token_hash: "x" })
    const token = await tokenFor(d)
    const r = await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: 101.82, ...BUYER })
    expect(r).toMatchObject({ ok: true, value: { orderId: "order-1", reference: "BILL-ALT2" } })
    expect(inserts).toHaveLength(1)
  })

  it("a second collision or any other insert error => generic 500", async () => {
    const dup = harness({ insertStorefrontOrder: async () => { throw Object.assign(new Error("dup"), { code: "23505" }) } })
    const t1 = await tokenFor(dup.d)
    expect(await initializeStorefrontBill(dup.d, "shop-A", { token: t1, amount: 100, expectedPay: 101.82, ...BUYER }))
      .toEqual({ ok: false, status: 500, error: "Could not create the order" })
    const boom = harness({ insertStorefrontOrder: async () => { throw Object.assign(new Error("relation secret"), { code: "42P01" }) } })
    const t2 = await tokenFor(boom.d)
    expect(await initializeStorefrontBill(boom.d, "shop-A", { token: t2, amount: 100, expectedPay: 101.82, ...BUYER }))
      .toEqual({ ok: false, status: 500, error: "Could not create the order" })
  })

  it("biller limits apply to the face", async () => {
    const { d } = harness()
    const token = await tokenFor(d)
    expect(await initializeStorefrontBill(d, "shop-A", { token, amount: 1001, expectedPay: 1, ...BUYER })).toMatchObject({ status: 400 })
    expect(await initializeStorefrontBill(d, "shop-A", { token, amount: 4, expectedPay: 1, ...BUYER })).toMatchObject({ status: 400 })
    expect(await initializeStorefrontBill(d, "shop-A", { token, amount: "10.001", expectedPay: 1, ...BUYER })).toMatchObject({ status: 400 })
  })

  it("switched off after verify => 403/503, nothing written", async () => {
    const base = harness()
    const token = await tokenFor(base.d)
    for (const over of [
      { cashback: CASHBACK({ storefrontGroups: { bills: false } }) },
      { hubtel: { enabled: true, paused: true, services: { bill_dstv: true } } },
    ]) {
      const h = harness(over as any)
      const r = await initializeStorefrontBill(h.d, "shop-A", { token, amount: 100, expectedPay: 101.82, ...BUYER })
      expect(r.ok).toBe(false)
      expect([403, 503]).toContain((r as any).status)
      expect(h.inserts).toHaveLength(0)
    }
  })

  it("gate on, no cashback rate => face + fee, no snapshot", async () => {
    const { d, inserts } = harness({ cashback: CASHBACK({ rates: {} }) })
    const token = await tokenFor(d)
    // fee = ceil(10000p * 1.95 %) = 195p
    const r = await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: 101.95, ...BUYER })
    expect(r).toMatchObject({ ok: true, value: { payAmount: 101.95, customerCashback: 0, paymentFee: 1.95 } })
    expect(inserts[0]).toMatchObject({ amount: 100, paid_amount: 101.95, cashback_amount: null, shop_share_amount: null })
  })

  it("pending caps => 429, nothing written", async () => {
    const { d, inserts } = harness()
    d.caps.countPending = async (_t, col) => (col === "buyer_email" ? 5 : 0)
    const token = await tokenFor(d)
    expect(await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: 101.82, ...BUYER })).toMatchObject({ status: 429 })
    expect(inserts).toHaveLength(0)
  })

  it("buyer details are required", async () => {
    const { d } = harness()
    const token = await tokenFor(d)
    expect(await initializeStorefrontBill(d, "shop-A", { token, amount: 100, expectedPay: 101.82, customerEmail: "ama@example.com" }))
      .toMatchObject({ status: 400 })
  })
})
