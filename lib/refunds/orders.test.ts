import { loadRefundableOrders, listPendingOrderRefs, resolveWalletUser } from "./orders"

type Rows = Record<string, unknown[]>

// Minimal chainable fake: every query builder is thenable and returns the canned rows for its table.
// `calls` records every builder method invocation as [table, method, ...args] for assertions.
function fakeDb(rows: Rows, calls: unknown[][] = []) {
  const make = (table: string) => {
    const rec = (m: string) => (...a: unknown[]) => { calls.push([table, m, ...a]); return q }
    const q: any = {
      select: rec("select"), eq: rec("eq"), in: rec("in"), is: rec("is"), neq: rec("neq"),
      order: rec("order"), range: rec("range"), ilike: rec("ilike"), or: rec("or"),
      maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(res),
    }
    return q
  }
  return { from: (t: string) => make(t) } as any
}

const EMPTY: Rows = {
  user_shops: [], shop_profits: [], shop_available_balance: [], wallets: [], transactions: [],
  payment_attempts: [], mtn_fulfillment_tracking: [], order_dispatch_claims: [], order_refunds: [],
  wallet_payments: [], users: [],
}

describe("loadRefundableOrders", () => {
  it("builds a ussd_shop order with a paystack payment, sub-agent owners and failed tracking", async () => {
    const db = fakeDb({
      ussd_shop_orders: [{
        id: "o1", shop_id: "shopA", dialing_phone: "0241112222", recipient_phone: "0243334444",
        network: "MTN", package_size: "2", amount: 12, order_status: "pending", payment_status: "completed",
        paystack_reference: "o1", created_at: "2026-10-05T00:00:00Z",
      }],
      user_shops: [{ id: "shopA", shop_name: "Alpha", user_id: "uA" }, { id: "shopP", shop_name: "Parent", user_id: "uP" }],
      shop_profits: [
        { ussd_shop_order_id: "o1", shop_id: "shopA", profit_amount: 3, status: "credited" },
        { ussd_shop_order_id: "o1", shop_id: "shopP", profit_amount: 2, status: "credited" },
      ],
      shop_available_balance: [{ shop_id: "shopA", available_balance: 10 }, { shop_id: "shopP", available_balance: 0 }],
      wallets: [{ user_id: "uA", balance: 0 }, { user_id: "uP", balance: 5 }],
      transactions: [],
      payment_attempts: [{ reference: "o1", fee: 0.18 }],
      mtn_fulfillment_tracking: [{ order_id: "o1", status: "failed" }],
      order_dispatch_claims: [{ order_id: "o1", last_outcome: "submitted" }],
      order_refunds: [],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_shop_orders", id: "o1" }])
    expect(o.payment).toMatchObject({ gateway: "paystack", reference: "o1", payerPhone: "0241112222" })
    expect(o.paid).toBe(12)
    expect(o.gatewayFee).toBe(0.18)
    expect(o.owners.map((x) => [x.shopId, x.credited, x.availableBalance, x.walletBalance])).toEqual([
      ["shopA", 3, 10, 0], ["shopP", 2, 0, 5],
    ])
    expect(o.evidence).toMatchObject({ trackingStatuses: ["failed"], dispatchOutcome: "submitted", hasActiveRefund: false })
  })

  it("detects a wallet-paid ussd order from the wallet debit transaction", async () => {
    const db = fakeDb({
      ussd_orders: [{
        id: "o2", dialing_phone: "0241112222", recipient_phone: "0241112222", network: "MTN", package_size: "1",
        amount: 6, order_status: "pending", payment_status: "completed", paystack_reference: null, created_at: "2026-10-05T00:00:00Z",
      }],
      transactions: [{ reference_id: "o2", user_id: "uW", type: "debit" }],
      user_shops: [], shop_profits: [], shop_available_balance: [], wallets: [],
      payment_attempts: [], mtn_fulfillment_tracking: [], order_dispatch_claims: [], order_refunds: [],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_orders", id: "o2" }])
    expect(o.payment).toMatchObject({ gateway: "wallet", walletUserId: "uW" })
    expect(o.owners).toEqual([])
  })

  it("builds a shop order from the completed wallet_payments row (amount incl. fee) and matches the user by phone", async () => {
    const db = fakeDb({
      ...EMPTY,
      shop_orders: [{
        id: "s1", shop_id: "shopA", customer_phone: "0241112222", customer_email: "c@x.com", network: "MTN",
        volume_gb: 2, total_price: 10, order_status: "pending", payment_status: "completed",
        external_order_id: "ext-9", created_at: "2026-10-05T00:00:00Z",
      }],
      wallet_payments: [
        { order_id: "s1", reference: "WALLET-old", amount: 10.3, fee: 0.3, status: "pending" },
        { order_id: "s1", reference: "WALLET-1", amount: 10.3, fee: 0.3, status: "completed" },
      ],
      payment_attempts: [{ reference: "WALLET-1", fee: 0.3 }],
      users: [{ id: "uBuyer" }],
      user_shops: [{ id: "shopA", shop_name: "Alpha", user_id: "uA" }],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "shop_orders", id: "s1" }])
    expect(o.payment).toEqual({ gateway: "paystack", reference: "WALLET-1", payerPhone: null, walletUserId: "uBuyer" })
    expect(o.recipientPhone).toBe("0241112222")
    expect(o.paid).toBe(10.3)
    expect(o.gatewayFee).toBe(0.3)
    expect(o.packageLabel).toBe("2GB")
    expect(o.shopName).toBe("Alpha")
    expect(o.evidence.externalOrderId).toBe("ext-9")
  })

  it("detects a wallet-paid shop order (dashboard stock purchase) from the wallet debit", async () => {
    const db = fakeDb({
      ...EMPTY,
      shop_orders: [{
        id: "s2", shop_id: "shopA", customer_phone: "0241112222", customer_email: "c@x.com", network: "MTN",
        volume_gb: 1, total_price: 5, order_status: "pending", payment_status: "completed",
        external_order_id: null, created_at: "2026-10-05T00:00:00Z",
      }],
      transactions: [{ reference_id: "s2", user_id: "uW", type: "debit" }],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "shop_orders", id: "s2" }])
    expect(o.payment).toMatchObject({ gateway: "wallet", walletUserId: "uW" })
    expect(o.payment.payerPhone).toBeNull()
    expect(o.paid).toBe(5)
    expect(o.gatewayFee).toBe(0)
  })

  it("returns gateway null when there is no payment evidence", async () => {
    const db = fakeDb({
      ...EMPTY,
      ussd_orders: [{
        id: "o3", dialing_phone: "0241112222", recipient_phone: "0241112222", network: "MTN", package_size: "1",
        amount: 6, order_status: "pending", payment_status: "completed", paystack_reference: null, created_at: "2026-10-05T00:00:00Z",
      }],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_orders", id: "o3" }])
    expect(o.payment.gateway).toBeNull()
    expect(o.payment.reference).toBeNull()
    expect(o.gatewayFee).toBe(0)
  })

  it("keeps pending profit separate and defaults a missing wallet row to 0", async () => {
    const db = fakeDb({
      ...EMPTY,
      ussd_shop_orders: [{
        id: "o4", shop_id: "shopA", dialing_phone: "0241112222", recipient_phone: "0241112222", network: "MTN",
        package_size: "1", amount: 8, order_status: "pending", payment_status: "completed",
        paystack_reference: "o4", created_at: "2026-10-05T00:00:00Z",
      }],
      user_shops: [{ id: "shopA", shop_name: "Alpha", user_id: "uA" }],
      shop_profits: [
        { ussd_shop_order_id: "o4", shop_id: "shopA", profit_amount: 1.5, status: "pending" },
        { ussd_shop_order_id: "other", shop_id: "shopA", profit_amount: 99, status: "credited" },
        { ussd_shop_order_id: "o4", shop_id: "shopZ", profit_amount: 0, status: "credited" },
      ],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_shop_orders", id: "o4" }])
    expect(o.owners).toEqual([
      { shopId: "shopA", ownerUserId: "uA", credited: 0, pending: 1.5, availableBalance: 0, walletBalance: 0 },
    ])
  })

  it("chunks id lookups at 100", async () => {
    const calls: unknown[][] = []
    const db = fakeDb({ ...EMPTY, ussd_orders: [] }, calls)
    const refs = Array.from({ length: 250 }, (_, i) => ({ table: "ussd_orders" as const, id: `id${i}` }))
    await loadRefundableOrders(db, refs)
    const ins = calls.filter((c) => c[0] === "ussd_orders" && c[1] === "in")
    expect(ins.map((c) => (c[3] as string[]).length)).toEqual([100, 100, 50])
  })
})

describe("listPendingOrderRefs", () => {
  it("merges tables newest-first and paginates", async () => {
    const db = fakeDb({
      shop_orders: [{ id: "s1", created_at: "2026-10-05T10:00:00Z" }, { id: "s2", created_at: "2026-10-05T08:00:00Z" }],
      ussd_orders: [{ id: "u1", created_at: "2026-10-05T09:00:00Z" }],
      ussd_shop_orders: [{ id: "h1", created_at: "2026-10-05T11:00:00Z" }],
    })
    const page1 = await listPendingOrderRefs(db, { pageSize: 2, page: 1 })
    expect(page1.map((r) => r.id)).toEqual(["h1", "s1"])
    const page2 = await listPendingOrderRefs(db, { pageSize: 2, page: 2 })
    expect(page2.map((r) => r.id)).toEqual(["u1", "s2"])
  })

  it("sanitises the search term and builds per-table or() filters", async () => {
    const calls: unknown[][] = []
    const db = fakeDb({ shop_orders: [], ussd_orders: [], ussd_shop_orders: [] }, calls)
    await listPendingOrderRefs(db, { pageSize: 10, page: 1, q: "024),id.eq.x(%" })
    const ors = calls.filter((c) => c[1] === "or")
    expect(ors.map((c) => c[0])).toEqual(["shop_orders", "ussd_orders", "ussd_shop_orders"])
    // only [0-9a-zA-Z-] survive: no commas/parens/dots/percent from user input can alter the filter structure
    expect(ors[0][2]).toBe("customer_phone.ilike.%024ideqx%")
    expect(ors[1][2]).toBe("dialing_phone.ilike.%024ideqx%,recipient_phone.ilike.%024ideqx%")
  })

  it("adds an id match for a full uuid and scopes shopId (not for ussd_orders)", async () => {
    const calls: unknown[][] = []
    const db = fakeDb({ shop_orders: [], ussd_orders: [], ussd_shop_orders: [] }, calls)
    const uuid = "123e4567-e89b-12d3-a456-426614174000"
    await listPendingOrderRefs(db, { pageSize: 10, page: 1, q: uuid, shopId: "shopA" })
    expect(calls.find((c) => c[0] === "shop_orders" && c[1] === "or")![2]).toContain(`,id.eq.${uuid}`)
    expect(calls.some((c) => c[0] === "ussd_orders" && c[1] === "eq" && c[2] === "shop_id")).toBe(false)
    expect(calls.some((c) => c[0] === "shop_orders" && c[1] === "eq" && c[2] === "shop_id" && c[3] === "shopA")).toBe(true)
  })
})

describe("resolveWalletUser", () => {
  it("falls back to email when the phone does not match", async () => {
    let n = 0
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (n++ === 0 ? { data: null } : { data: { id: "uE" } }) }) }) }) } as any
    expect(await resolveWalletUser(db, { phone: "+233241112222", email: "A@B.com" })).toBe("uE")
  })
  it("returns null with no inputs", async () => {
    expect(await resolveWalletUser(fakeDb({}), {})).toBeNull()
  })
})
