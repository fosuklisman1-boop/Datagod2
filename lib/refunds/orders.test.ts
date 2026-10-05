import { loadRefundableOrders, listPendingOrderRefs, resolveWalletUser } from "./orders"

type Rows = Record<string, unknown[]>

// Minimal chainable fake: every query builder is thenable and returns the canned rows for its table.
// `calls` records every builder method invocation as [table, method, ...args] for assertions.
function fakeDb(rows: Rows, calls: unknown[][] = [], errors: Record<string, string> = {}) {
  const make = (table: string) => {
    const rec = (m: string) => (...a: unknown[]) => { calls.push([table, m, ...a]); return q }
    let key = table
    const q: any = {
      // errors may be keyed "table" or "table:<select string>" to fail one specific query
      select: (...a: unknown[]) => { calls.push([table, "select", ...a]); if (errors[`${table}:${a[0]}`]) key = `${table}:${a[0]}`; return q }, eq: rec("eq"), in: rec("in"), is: rec("is"), neq: rec("neq"),
      order: rec("order"), range: rec("range"), limit: rec("limit"), ilike: rec("ilike"), or: rec("or"),
      maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: errors[key] ? { message: errors[key] } : null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: errors[key] ? { message: errors[key] } : null }).then(res),
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
      order_dispatch_claims: [{ order_id: "o1", last_outcome: "submitted", attempts: 2 }],
      order_refunds: [],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_shop_orders", id: "o1" }])
    expect(o.payment).toMatchObject({ gateway: "paystack", reference: "o1", payerPhone: "0241112222" })
    expect(o.paid).toBe(12)
    expect(o.gatewayFee).toBe(0.18)
    expect(o.owners.map((x) => [x.shopId, x.credited, x.availableBalance, x.walletBalance])).toEqual([
      ["shopA", 3, 10, 0], ["shopP", 2, 0, 5],
    ])
    expect(o.evidence).toMatchObject({ trackingStatuses: ["failed"], dispatchOutcome: "submitted", dispatchAttempts: 2, hasActiveRefund: false })
  })

  it("detects a wallet-paid ussd order from the wallet debit transaction", async () => {
    const db = fakeDb({
      ussd_orders: [{
        id: "o2", dialing_phone: "0241112222", recipient_phone: "0241112222", network: "MTN", package_size: "1",
        amount: 6, order_status: "pending", payment_status: "completed", paystack_reference: null, created_at: "2026-10-05T00:00:00Z",
      }],
      transactions: [{ reference_id: "o2", user_id: "uW", type: "debit", amount: 6 }],
      user_shops: [], shop_profits: [], shop_available_balance: [], wallets: [],
      payment_attempts: [], mtn_fulfillment_tracking: [], order_dispatch_claims: [], order_refunds: [],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_orders", id: "o2" }])
    expect(o.payment).toMatchObject({ gateway: "wallet", walletUserId: "uW" })
    expect(o.owners).toEqual([])
  })

  it("builds a shop order from the completed wallet_payments row (amount incl. fee) and never resolves the wallet user from buyer-typed phone/email", async () => {
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
    expect(o.payment).toEqual({ gateway: "paystack", reference: "WALLET-1", payerPhone: null, walletUserId: null })
    expect(o.recipientPhone).toBe("0241112222")
    expect(o.paid).toBe(10.3)
    expect(o.gatewayFee).toBe(0.3)
    expect(o.packageLabel).toBe("2GB")
    expect(o.shopName).toBe("Alpha")
    expect(o.evidence.externalOrderId).toBe("ext-9")
  })

  describe("shop order payer number", () => {
    const shopRows = (attempt: unknown[]): Rows => ({
      ...EMPTY,
      shop_orders: [{
        id: "s1", shop_id: "shopA", customer_phone: "0249999999", customer_email: "c@x.com", network: "MTN",
        volume_gb: 2, total_price: 10, order_status: "pending", payment_status: "completed",
        external_order_id: null, created_at: "2026-10-05T00:00:00Z",
      }],
      wallet_payments: [{ order_id: "s1", reference: "WALLET-1", amount: 10.3, fee: 0.3, status: "completed" }],
      payment_attempts: attempt,
      user_shops: [{ id: "shopA", shop_name: "Alpha", user_id: "uA" }],
    })

    it("uses the recorded payer_phone (normalised), never customer_phone", async () => {
      const db = fakeDb(shopRows([{ reference: "WALLET-1", fee: 0.3, payer_phone: "+233 24 111 2222" }]))
      const [o] = await loadRefundableOrders(db, [{ table: "shop_orders", id: "s1" }])
      expect(o.payment.payerPhone).toBe("0241112222")
      expect(o.recipientPhone).toBe("0249999999")
    })

    it("is null when payer_phone is absent or null", async () => {
      for (const attempt of [[], [{ reference: "WALLET-1", fee: 0.3, payer_phone: null }]]) {
        const [o] = await loadRefundableOrders(fakeDb(shopRows(attempt)), [{ table: "shop_orders", id: "s1" }])
        expect(o.payment.payerPhone).toBeNull()
      }
    })

    it("degrades to null when the payer_phone column does not exist yet", async () => {
      const db = fakeDb(shopRows([{ reference: "WALLET-1", fee: 0.3 }]), [], {
        "payment_attempts:reference, payer_phone": "column payment_attempts.payer_phone does not exist",
      })
      const [o] = await loadRefundableOrders(db, [{ table: "shop_orders", id: "s1" }])
      expect(o.payment.payerPhone).toBeNull()
      expect(o.gatewayFee).toBe(0.3)
    })

    it("throws on any other payer lookup error", async () => {
      const db = fakeDb(shopRows([]), [], { "payment_attempts:reference, payer_phone": "connection reset" })
      await expect(loadRefundableOrders(db, [{ table: "shop_orders", id: "s1" }])).rejects.toThrow(/payer lookup failed/)
    })
  })

  it("detects a wallet-paid shop order (dashboard stock purchase) from the wallet debit", async () => {
    const db = fakeDb({
      ...EMPTY,
      shop_orders: [{
        id: "s2", shop_id: "shopA", customer_phone: "0241112222", customer_email: "c@x.com", network: "MTN",
        volume_gb: 1, total_price: 5, order_status: "pending", payment_status: "completed",
        external_order_id: null, created_at: "2026-10-05T00:00:00Z",
      }],
      transactions: [{ reference_id: "s2", user_id: "uW", type: "debit", amount: 5 }],
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

  it("adds an id match for a full uuid and scopes shopId, skipping ussd_orders entirely", async () => {
    const calls: unknown[][] = []
    const db = fakeDb({ shop_orders: [], ussd_orders: [], ussd_shop_orders: [] }, calls)
    const uuid = "123e4567-e89b-12d3-a456-426614174000"
    await listPendingOrderRefs(db, { pageSize: 10, page: 1, q: uuid, shopId: "shopA" })
    expect(calls.find((c) => c[0] === "shop_orders" && c[1] === "or")![2]).toContain(`,id.eq.${uuid}`)
    expect(calls.some((c) => c[0] === "ussd_orders")).toBe(false)
    expect(calls.some((c) => c[0] === "shop_orders" && c[1] === "eq" && c[2] === "shop_id" && c[3] === "shopA")).toBe(true)
  })
})

describe("resolveWalletUser", () => {
  it("falls back to email when the phone does not match", async () => {
    let n = 0
    const chain: any = { eq: () => chain, limit: async () => (n++ === 0 ? { data: [], error: null } : { data: [{ id: "uE" }], error: null }) }
    const db = { from: () => ({ select: () => chain }) } as any
    expect(await resolveWalletUser(db, { phone: "+233241112222", email: "A@B.com" })).toBe("uE")
  })
  it("treats 2+ accounts on one phone as no wallet user (never throws)", async () => {
    const db = fakeDb({ users: [{ id: "u1" }, { id: "u2" }] })
    expect(await resolveWalletUser(db, { phone: "0241112222" })).toBeNull()
  })
  it("only matches phone-verified accounts and uses limit(2)", async () => {
    const calls: unknown[][] = []
    const db = fakeDb({ users: [{ id: "u1" }] }, calls)
    expect(await resolveWalletUser(db, { phone: "0241112222" })).toBe("u1")
    expect(calls).toContainEqual(["users", "eq", "phone_verified", true])
    expect(calls).toContainEqual(["users", "limit", 2])
  })
  it("treats 2+ accounts on one email as no wallet user", async () => {
    const db = fakeDb({ users: [{ id: "u1" }, { id: "u2" }] })
    expect(await resolveWalletUser(db, { email: "a@b.com" })).toBeNull()
  })
  it("returns null with no inputs", async () => {
    expect(await resolveWalletUser(fakeDb({}), {})).toBeNull()
  })
})

describe("fix round 1", () => {
  const shopRow = {
    id: "s1", shop_id: "shopA", customer_phone: "0241112222", customer_email: "c@x.com", network: "MTN",
    volume_gb: 1, total_price: 5, order_status: "pending", payment_status: "completed",
    external_order_id: null, created_at: "2026-10-05T00:00:00Z",
  }

  it("sums profits in integer pesewas (0.1 + 0.2 => exactly 0.3)", async () => {
    const db = fakeDb({
      ...EMPTY,
      shop_orders: [shopRow],
      user_shops: [{ id: "shopA", shop_name: "A", user_id: "uA" }],
      shop_profits: [
        { shop_order_id: "s1", shop_id: "shopA", profit_amount: 0.1, status: "credited" },
        { shop_order_id: "s1", shop_id: "shopA", profit_amount: 0.2, status: "credited" },
        { shop_order_id: "s1", shop_id: "shopA", profit_amount: 0.1, status: "pending" },
        { shop_order_id: "s1", shop_id: "shopA", profit_amount: 0.2, status: "pending" },
      ],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "shop_orders", id: "s1" }])
    expect(o.owners[0].credited).toBe(0.3)
    expect(o.owners[0].pending).toBe(0.3)
  })

  it("shop order walletUserId comes only from a proving debit, never from a matching user", async () => {
    const none = fakeDb({ ...EMPTY, shop_orders: [shopRow], users: [{ id: "uSomeone" }] })
    const [a] = await loadRefundableOrders(none, [{ table: "shop_orders", id: "s1" }])
    expect(a.payment.walletUserId).toBeNull()
    const withDebit = fakeDb({ ...EMPTY, shop_orders: [shopRow], users: [{ id: "uSomeone" }], transactions: [{ reference_id: "s1", user_id: "uPayer", type: "debit", amount: 5 }] })
    const [b] = await loadRefundableOrders(withDebit, [{ table: "shop_orders", id: "s1" }])
    expect(b.payment.walletUserId).toBe("uPayer")
  })

  it("ussd orders still resolve the wallet user by dialing phone", async () => {
    const db = fakeDb({
      ...EMPTY,
      ussd_orders: [{ id: "o9", dialing_phone: "0241112222", recipient_phone: "0241112222", network: "MTN", package_size: "1", amount: 6, order_status: "pending", payment_status: "completed", paystack_reference: "o9", created_at: "2026-10-05T00:00:00Z" }],
      users: [{ id: "uDialer" }],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_orders", id: "o9" }])
    expect(o.payment.walletUserId).toBe("uDialer")
  })

  it("throws when a result set reaches 1000 rows", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ order_id: "s1", shop_order_id: "s1", status: "failed", i }))
    const db = fakeDb({ ...EMPTY, shop_orders: [shopRow], mtn_fulfillment_tracking: many })
    await expect(loadRefundableOrders(db, [{ table: "shop_orders", id: "s1" }])).rejects.toThrow(/mtn_fulfillment_tracking/)
  })

  it("uses 50-id chunks for mtn_fulfillment_tracking", async () => {
    const calls: unknown[][] = []
    const rows = Array.from({ length: 100 }, (_, i) => ({ ...shopRow, id: `s${i}` }))
    const db = fakeDb({ ...EMPTY, shop_orders: rows }, calls)
    await loadRefundableOrders(db, rows.map((r) => ({ table: "shop_orders" as const, id: r.id })))
    const ins = calls.filter((c) => c[0] === "mtn_fulfillment_tracking" && c[1] === "in")
    expect(ins.map((c) => (c[3] as string[]).length)).toEqual([50, 50])
  })

  it("throws on a query error", async () => {
    const db = fakeDb({ ...EMPTY, shop_orders: [shopRow] }, [], { order_refunds: "boom" })
    await expect(loadRefundableOrders(db, [{ table: "shop_orders", id: "s1" }])).rejects.toThrow(/order_refunds lookup failed: boom/)
  })

  it("flags hasActiveRefund for a processing refund and reports shop_orders tracking + claim evidence", async () => {
    const db = fakeDb({
      ...EMPTY,
      shop_orders: [shopRow],
      order_refunds: [{ order_id: "s1", status: "processing" }],
      mtn_fulfillment_tracking: [{ shop_order_id: "s1", status: "failed" }, { shop_order_id: "other", status: "completed" }],
      order_dispatch_claims: [{ order_id: "s1", last_outcome: "unknown", attempts: 1 }],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "shop_orders", id: "s1" }])
    expect(o.evidence).toMatchObject({ hasActiveRefund: true, trackingStatuses: ["failed"], dispatchOutcome: "unknown" })
  })

  it("list: ussd_orders is skipped when shopId is set, and [] for table ussd_orders + shopId", async () => {
    const db = fakeDb({
      shop_orders: [{ id: "s1", created_at: "2026-10-05T10:00:00Z" }],
      ussd_orders: [{ id: "u1", created_at: "2026-10-05T11:00:00Z" }],
      ussd_shop_orders: [],
    })
    const r = await listPendingOrderRefs(db, { pageSize: 10, page: 1, shopId: "shopA" })
    expect(r.map((x) => x.id)).toEqual(["s1"])
    expect(await listPendingOrderRefs(db, { pageSize: 10, page: 1, shopId: "shopA", table: "ussd_orders" })).toEqual([])
  })

  it("list: ties on createdAt are ordered deterministically by table:id", async () => {
    const ts = "2026-10-05T10:00:00Z"
    const db = fakeDb({ shop_orders: [{ id: "b", created_at: ts }], ussd_orders: [{ id: "a", created_at: ts }], ussd_shop_orders: [{ id: "c", created_at: ts }] })
    const r = await listPendingOrderRefs(db, { pageSize: 10, page: 1 })
    expect(r.map((x) => `${x.table}:${x.id}`)).toEqual(["shop_orders:b", "ussd_orders:a", "ussd_shop_orders:c"])
  })

  it("resolveWalletUser throws on a real query error", async () => {
    const db = fakeDb({}, [], { users: "db down" })
    await expect(resolveWalletUser(db, { phone: "0241112222" })).rejects.toThrow(/users lookup failed/)
  })
})

describe("I-2: wallet-debit proof rules", () => {
  const ussd = (over: Record<string, unknown> = {}) => ({
    id: "o7", dialing_phone: "0241112222", recipient_phone: "0241112222", network: "MTN", package_size: "1", amount: 6,
    order_status: "pending", payment_status: "completed", paystack_reference: null, created_at: "2026-10-05T00:00:00Z", ...over,
  })
  const shop = {
    id: "s7", shop_id: "shopA", customer_phone: "0241112222", customer_email: null, network: "MTN", volume_gb: 1, total_price: 5,
    order_status: "pending", payment_status: "completed", external_order_id: null, created_at: "2026-10-05T00:00:00Z",
  }
  const load = async (table: "ussd_orders" | "shop_orders", id: string, rows: Rows) => (await loadRefundableOrders(fakeDb({ ...EMPTY, ...rows }), [{ table, id }]))[0]

  it("a token debit (amount mismatch) does not make the user the wallet payer of a ussd order", async () => {
    const o = await load("ussd_orders", "o7", { ussd_orders: [ussd()], transactions: [{ reference_id: "o7", user_id: "uEvil", type: "debit", amount: 0.01 }] })
    expect(o.payment.gateway).toBeNull()
    expect(o.payment.walletUserId).toBeNull()
  })
  it("a matching single debit proves wallet payment (within 0.01)", async () => {
    const o = await load("ussd_orders", "o7", { ussd_orders: [ussd()], transactions: [{ reference_id: "o7", user_id: "uW", type: "debit", amount: "6.005" }] })
    expect(o.payment).toMatchObject({ gateway: "wallet", walletUserId: "uW" })
  })
  it("two qualifying debits => no wallet proof", async () => {
    const o = await load("ussd_orders", "o7", { ussd_orders: [ussd()], transactions: [
      { reference_id: "o7", user_id: "uA", type: "debit", amount: 6 }, { reference_id: "o7", user_id: "uB", type: "debit", amount: 6 }] })
    expect(o.payment.gateway).toBeNull()
  })
  it("a mismatching debit next to one matching debit does not count as a second", async () => {
    const o = await load("ussd_orders", "o7", { ussd_orders: [ussd()], transactions: [
      { reference_id: "o7", user_id: "uW", type: "debit", amount: 6 }, { reference_id: "o7", user_id: "uEvil", type: "debit", amount: 0.01 }] })
    expect(o.payment).toMatchObject({ gateway: "wallet", walletUserId: "uW" })
  })
  it("a paystack-referenced ussd order is never reclassified to wallet by a matching debit", async () => {
    const o = await load("ussd_orders", "o7", { ussd_orders: [ussd({ paystack_reference: "ref7" })], users: [{ id: "uDialer" }],
      transactions: [{ reference_id: "o7", user_id: "uEvil", type: "debit", amount: 6 }] })
    expect(o.payment).toMatchObject({ gateway: "paystack", reference: "ref7", walletUserId: "uDialer" })
  })
  it("shop order: a mismatching debit gives no wallet gateway and no walletUserId", async () => {
    const o = await load("shop_orders", "s7", { shop_orders: [shop], transactions: [{ reference_id: "s7", user_id: "uEvil", type: "debit", amount: 0.01 }] })
    expect(o.payment).toMatchObject({ gateway: null, walletUserId: null })
  })
  it("shop order paid by paystack: walletUserId only from a qualifying debit", async () => {
    const wp = [{ order_id: "s7", reference: "W1", amount: 5.3, fee: 0.3, status: "completed" }]
    const bad = await load("shop_orders", "s7", { shop_orders: [shop], wallet_payments: wp, transactions: [{ reference_id: "s7", user_id: "uEvil", type: "debit", amount: 0.01 }] })
    expect(bad.payment).toMatchObject({ gateway: "paystack", walletUserId: null })
    const good = await load("shop_orders", "s7", { shop_orders: [shop], wallet_payments: wp, transactions: [{ reference_id: "s7", user_id: "uPayer", type: "debit", amount: 5.3 }] })
    expect(good.payment.walletUserId).toBe("uPayer")
  })
})
