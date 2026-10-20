import { describe, it, expect, vi } from "vitest"
import { botChargeMomo, BOT_MOMO_PHONE_CAP, type BotChargeInput, type BotMomoDeps } from "./momo"
import { submitBotOtp, type BotOtpPointer } from "./otp-pointer"
import { BOT_UNPAID_FAILURE_REASON } from "@/lib/ussd-hubtel/order-tables"
import { DEFAULT_BOT_PAYMENT_EMAIL, STOREFRONT_PAYMENT_CHANNEL, STOREFRONT_PAYMENT_PURPOSE } from "@/lib/storefront-commission/payment"

type Row = Record<string, any>

const NOW = Date.parse("2026-10-20T10:00:00Z")
const SHOP = "11111111-2222-4333-8444-555555555555"
const OTHER_SHOP = "99999999-2222-4333-8444-555555555555"
const DIAL = "233241234567"

/** In-memory PostgREST stand-in: select / insert / update with eq / in filters; records every update. */
function fakeDb(tables: Record<string, Row[]>, opts: { insertError?: Record<string, unknown>; readError?: boolean } = {}) {
  const updates: { table: string; patch: Row; filters: [string, string, unknown][] }[] = []
  function from(table: string) {
    const rows = (tables[table] ??= [])
    let op: "select" | "insert" | "update" = "select"
    let payload: any
    const filters: [string, string, unknown][] = []
    const match = (r: Row) => filters.every(([k, c, v]) => (k === "eq" ? r[c] === v : k === "in" ? (v as unknown[]).includes(r[c]) : r[c] === v))
    const run = () => {
      if (op === "insert") {
        const err = opts.insertError?.[table]
        if (err) return { data: null, error: err }
        rows.push(...([] as Row[]).concat(payload).map(r => ({ ...r })))
        return { data: null, error: null }
      }
      if (op === "update") {
        const hit = rows.filter(match)
        hit.forEach(r => Object.assign(r, payload))
        updates.push({ table, patch: payload, filters: [...filters] })
        return { data: hit.map(r => ({ id: r.id })), error: null }
      }
      if (opts.readError) return { data: null, error: { message: "boom" } }
      return { data: rows.filter(match).map(r => ({ ...r })), error: null }
    }
    const b: any = {
      select: () => b,
      insert: (p: any) => { op = "insert"; payload = p; return b },
      update: (p: any) => { op = "update"; payload = p; return b },
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return b },
      in: (c: string, v: unknown[]) => { filters.push(["in", c, v]); return b },
      is: (c: string, v: unknown) => { filters.push(["is", c, v]); return b },
      maybeSingle: async () => { const r = run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error } },
      single: async () => { const r = run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error } },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { client: { from } as any, tables, updates }
}

function bundleRow(o: Row = {}): Row {
  return {
    id: "d1", channel: "bots", bot_surface: "ussd_shop", shop_id: SHOP, status: "pending", payment_status: "unpaid",
    amount: 10, paid_amount: 10.03, buyer_email: null, buyer_phone: DIAL, ...o,
  }
}
function billRow(o: Row = {}): Row {
  return {
    id: "b1", channel: "bots", bot_surface: "ussd", shop_id: null, status: "pending", payment_status: "unpaid",
    amount: 20, paid_amount: 20.22, buyer_email: null, buyer_phone: DIAL, ...o,
  }
}

function make(opts: {
  bundles?: Row[]; bills?: Row[]; chargeStatus?: string; chargeThrows?: boolean; insertError?: Record<string, unknown>; readError?: boolean
  otpStatus?: string; otpThrows?: boolean
} = {}) {
  const db = fakeDb(
    { hubtel_data_orders: opts.bundles ?? [bundleRow()], hubtel_bill_orders: opts.bills ?? [billRow()], wallet_payments: [] },
    { insertError: opts.insertError, readError: opts.readError },
  )
  const charges: any[] = []
  const limiter = new Map<string, number>()
  const pointers = new Map<string, BotOtpPointer>()
  const deps: BotMomoDeps = {
    db: db.client,
    chargeMobileMoney: vi.fn(async (p: any) => {
      charges.push(p)
      if (opts.chargeThrows) throw new Error("Paystack charge failed (HTTP 400)")
      return { status: opts.chargeStatus ?? "pay_offline", reference: p.reference }
    }),
    submitOtp: vi.fn(async (reference: string) => {
      if (opts.otpThrows) throw new Error("network")
      return { status: opts.otpStatus ?? "pending", reference }
    }),
    recordPayerPhone: vi.fn(async () => {}),
    rateLimit: vi.fn(async (name: string, max: number, _w: number, id: string) => {
      const k = `${name}:${id}`
      const n = (limiter.get(k) ?? 0) + 1
      limiter.set(k, n)
      return n <= max
    }),
    otpPointer: {
      set: vi.fn(async (phone: string, p: BotOtpPointer) => { pointers.set(phone, { ...p, phone }) }),
      clear: vi.fn(async (phone: string) => { pointers.delete(phone) }),
    },
    now: () => NOW,
  }
  return { deps, db, charges, pointers, limiter }
}

const SHOP_BUNDLE: BotChargeInput = { orderType: "cs_bundle", orderId: "d1", botSurface: "ussd_shop", shopId: SHOP, dialingPhone: DIAL }
const MAIN_BILL: BotChargeInput = { orderType: "cs_bill", orderId: "b1", botSurface: "ussd", shopId: null, dialingPhone: "0241234567" }

// Whole words (letters only around them, so the brand domain "datagod" is fine but "cs_bundle" is caught).
const PRODUCT_WORDS = /(?<![a-z])(bills?|bundles?|data|airtime|cashback|commission|ecg|internet)(?![a-z])/i

describe("botChargeMomo: happy path", () => {
  it("charges paid_amount (not amount) to the dialing number with one wallet_payments row", async () => {
    const m = make()
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.reference).toMatch(/^[0-9a-f]{32}$/)
    expect(r.status).toBe("pay_offline")

    expect(m.charges).toHaveLength(1)
    const c = m.charges[0]
    expect(c).toMatchObject({
      amount: 10.03, phone: "0241234567", provider: "mtn", reference: r.reference, email: DEFAULT_BOT_PAYMENT_EMAIL,
      channel: STOREFRONT_PAYMENT_CHANNEL, purpose: STOREFRONT_PAYMENT_PURPOSE,
    })
    expect(c.metadata).toEqual({ source: "ussd_bot", bot_surface: "ussd_shop", order_type: STOREFRONT_PAYMENT_CHANNEL })
    expect(c.recipient).toBeUndefined()
    // Nothing that leaves our system names the product.
    expect(r.reference).not.toMatch(PRODUCT_WORDS)
    expect(JSON.stringify({ m: c.metadata, ch: c.channel, p: c.purpose, e: c.email })).not.toMatch(PRODUCT_WORDS)

    expect(m.db.tables.wallet_payments).toHaveLength(1)
    expect(m.db.tables.wallet_payments[0]).toEqual({
      user_id: null, shop_id: SHOP, order_id: "d1", order_type: "cs_bundle", amount: 10.03, fee: 0, reference: r.reference,
      status: "pending", payment_method: "paystack", created_at: new Date(NOW).toISOString(),
    })
    // The order is untouched by the charge itself (the webhook flips it).
    expect(m.db.tables.hubtel_data_orders[0]).toMatchObject({ status: "pending", payment_status: "unpaid" })
    expect(m.db.updates).toEqual([])
  })

  it("main-menu bill: shop_id null, cs_bill, Telecel number => vod", async () => {
    const m = make({ bills: [billRow({ buyer_phone: "233201234567" })] })
    const r = await botChargeMomo(m.deps, { ...MAIN_BILL, dialingPhone: "+233201234567" })
    expect(r.ok).toBe(true)
    expect(m.charges[0]).toMatchObject({ amount: 20.22, phone: "0201234567", provider: "vod" })
    expect(m.charges[0].metadata).toEqual({ source: "ussd_bot", bot_surface: "ussd", order_type: STOREFRONT_PAYMENT_CHANNEL })
    expect(m.db.tables.wallet_payments[0]).toMatchObject({ shop_id: null, order_id: "b1", order_type: "cs_bill", amount: 20.22, fee: 0 })
  })

  it("records the payer phone via recordPayerPhone (payment_type shop_order, neutral email)", async () => {
    const m = make()
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    if (!r.ok) throw new Error("expected ok")
    expect(m.deps.recordPayerPhone).toHaveBeenCalledTimes(1)
    expect(m.deps.recordPayerPhone).toHaveBeenCalledWith(m.db.client, {
      reference: r.reference,
      rawPhone: "0241234567",
      baseRow: {
        user_id: null, reference: r.reference, amount: 10.03, fee: 0, email: DEFAULT_BOT_PAYMENT_EMAIL, status: "pending",
        payment_type: "shop_order", shop_id: SHOP, order_id: "d1", created_at: new Date(NOW).toISOString(),
      },
    })
  })

  it("send_otp stores an OTP pointer for the dialing phone (local form)", async () => {
    const m = make({ chargeStatus: "send_otp" })
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    if (!r.ok) throw new Error("expected ok")
    expect(r.status).toBe("send_otp")
    expect(m.deps.otpPointer.set).toHaveBeenCalledWith("0241234567", {
      reference: r.reference, orderType: "cs_bundle", orderId: "d1", createdAt: new Date(NOW).toISOString(),
    })
  })

  it("no OTP pointer for a plain prompt", async () => {
    const m = make()
    await botChargeMomo(m.deps, SHOP_BUNDLE)
    expect(m.deps.otpPointer.set).not.toHaveBeenCalled()
  })
})

describe("botChargeMomo: refusals (NOT_PAYABLE: no payment row, no charge, no write)", () => {
  const cases: [string, Partial<{ bundles: Row[] }>, Partial<BotChargeInput>][] = [
    ["paid", { bundles: [bundleRow({ payment_status: "paid" })] }, {}],
    ["failed", { bundles: [bundleRow({ status: "failed" })] }, {}],
    ["processing", { bundles: [bundleRow({ status: "processing" })] }, {}],
    ["storefront channel", { bundles: [bundleRow({ channel: "storefront" })] }, {}],
    ["dashboard channel", { bundles: [bundleRow({ channel: "dashboard" })] }, {}],
    ["wrong bot_surface (whatsapp_shop)", { bundles: [bundleRow({ bot_surface: "whatsapp_shop" })] }, {}],
    ["wrong bot_surface (hubtel_ussd)", { bundles: [bundleRow({ bot_surface: "hubtel_ussd" })] }, {}],
    ["different shop", { bundles: [bundleRow({ shop_id: OTHER_SHOP })] }, {}],
    ["shop surface without a shop id", {}, { shopId: null }],
    ["main surface given a shop id", { bundles: [bundleRow({ bot_surface: "ussd" })] }, { botSurface: "ussd", shopId: SHOP }],
    ["main surface but the row has a shop", { bundles: [bundleRow({ bot_surface: "ussd" })] }, { botSurface: "ussd", shopId: null }],
    ["another buyer's order", { bundles: [bundleRow({ buyer_phone: "233551112222" })] }, {}],
    ["missing order", { bundles: [] }, {}],
    ["no paid_amount", { bundles: [bundleRow({ paid_amount: null })] }, {}],
  ]
  for (const [name, world, input] of cases) {
    it(name, async () => {
      const m = make(world)
      const before = JSON.stringify(m.db.tables.hubtel_data_orders)
      const r = await botChargeMomo(m.deps, { ...SHOP_BUNDLE, ...input })
      expect(r).toMatchObject({ ok: false, code: "NOT_PAYABLE" })
      expect(m.charges).toHaveLength(0)
      expect(m.db.tables.wallet_payments).toHaveLength(0)
      expect(m.db.updates).toEqual([])
      expect(JSON.stringify(m.db.tables.hubtel_data_orders)).toBe(before)
      expect(m.deps.rateLimit).not.toHaveBeenCalled()
    })
  }

  it("unknown order type is refused", async () => {
    const m = make()
    const r = await botChargeMomo(m.deps, { ...SHOP_BUNDLE, orderType: "airtime" as any })
    expect(r).toMatchObject({ ok: false, code: "NOT_PAYABLE" })
    expect(m.charges).toHaveLength(0)
  })

  it("an order read error is CHARGE_FAILED and writes nothing", async () => {
    const m = make({ readError: true })
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    expect(r).toMatchObject({ ok: false, code: "CHARGE_FAILED" })
    expect(m.charges).toHaveLength(0)
    expect(m.db.updates).toEqual([])
  })
})

/** The guarded fail patch on the order: only a channel 'bots', pending, unpaid row. */
function expectGuardedFail(m: ReturnType<typeof make>, table: string, id: string) {
  const u = m.db.updates.find(x => x.table === table)
  expect(u).toBeDefined()
  expect(u!.patch).toMatchObject({ status: "failed", failure_reason: BOT_UNPAID_FAILURE_REASON })
  expect(u!.patch).not.toHaveProperty("payment_status")
  expect(u!.filters).toEqual(expect.arrayContaining([
    ["eq", "id", id], ["in", "payment_status", ["unpaid"]], ["in", "channel", ["bots"]], ["in", "status", ["pending"]],
  ]))
}

describe("botChargeMomo: no provider / cap / charge failure", () => {
  it("NO_PROVIDER for a number with no MoMo provider: no charge, no payment row, order failed (guarded)", async () => {
    const m = make({ bundles: [bundleRow({ buyer_phone: "233311234567" })] })
    const r = await botChargeMomo(m.deps, { ...SHOP_BUNDLE, dialingPhone: "0311234567" })
    expect(r).toEqual({ ok: false, code: "NO_PROVIDER", message: "Payment not available for your number." })
    expect(m.charges).toHaveLength(0)
    expect(m.db.tables.wallet_payments).toHaveLength(0)
    expectGuardedFail(m, "hubtel_data_orders", "d1")
    expect(m.db.tables.hubtel_data_orders[0]).toMatchObject({ status: "failed", payment_status: "unpaid" })
  })

  it("RATE_LIMITED after 3 charges in an hour for one phone (key mp:<local digits>)", async () => {
    const m = make({ bundles: ["d1", "d2", "d3", "d4"].map(id => bundleRow({ id })) })
    for (const id of ["d1", "d2", "d3"]) {
      expect((await botChargeMomo(m.deps, { ...SHOP_BUNDLE, orderId: id })).ok).toBe(true)
    }
    const r = await botChargeMomo(m.deps, { ...SHOP_BUNDLE, orderId: "d4" })
    expect(r).toEqual({ ok: false, code: "RATE_LIMITED", message: "Too many attempts. Please try later." })
    expect(m.charges).toHaveLength(3)
    expect(m.db.tables.wallet_payments).toHaveLength(3)
    expect(m.deps.rateLimit).toHaveBeenCalledWith("momodirect_phone", 3, 60 * 60 * 1000, "mp:0241234567")
    expect(BOT_MOMO_PHONE_CAP).toEqual({ name: "momodirect_phone", max: 3, windowMs: 60 * 60 * 1000 })
    expectGuardedFail(m, "hubtel_data_orders", "d4")
    expect(m.db.tables.hubtel_data_orders.find(r => r.id === "d4")).toMatchObject({ status: "failed" })
  })

  it("the cap is per phone: any format of the same number shares it", async () => {
    const m = make({ bundles: ["d1", "d2", "d3", "d4"].map(id => bundleRow({ id })) })
    const phones = ["0241234567", "233241234567", "+233241234567", "0241234567"]
    const out = []
    for (const [i, id] of ["d1", "d2", "d3", "d4"].entries()) out.push(await botChargeMomo(m.deps, { ...SHOP_BUNDLE, orderId: id, dialingPhone: phones[i] }))
    expect(out.map(o => o.ok)).toEqual([true, true, true, false])
  })

  it("charge throws => CHARGE_FAILED, payment row failed, order failed with the guarded patch", async () => {
    const m = make({ chargeThrows: true })
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    expect(r).toEqual({ ok: false, code: "CHARGE_FAILED", message: "Service unavailable. Please try again later." })
    expect(m.db.tables.wallet_payments).toHaveLength(1)
    expect(m.db.tables.wallet_payments[0].status).toBe("failed")
    const wp = m.db.updates.find(u => u.table === "wallet_payments")!
    expect(wp.filters).toEqual(expect.arrayContaining([["eq", "reference", m.db.tables.wallet_payments[0].reference], ["eq", "status", "pending"]]))
    expectGuardedFail(m, "hubtel_data_orders", "d1")
    expect(m.db.tables.hubtel_data_orders[0]).toMatchObject({ status: "failed", failure_reason: BOT_UNPAID_FAILURE_REASON, payment_status: "unpaid" })
    expect(m.deps.recordPayerPhone).not.toHaveBeenCalled()
    // never leaks provider text
    expect(r.ok ? "" : r.message).not.toMatch(/paystack|http/i)
  })

  it("charge throws for an order that got paid meanwhile => the paid row is untouched", async () => {
    const m = make({ chargeThrows: true })
    m.deps.chargeMobileMoney = vi.fn(async () => {
      // A webhook for an earlier attempt flips the row before our failure handling runs.
      Object.assign(m.db.tables.hubtel_data_orders[0], { payment_status: "paid" })
      throw new Error("timeout")
    })
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    expect(r).toMatchObject({ ok: false, code: "CHARGE_FAILED" })
    expect(m.db.tables.hubtel_data_orders[0]).toMatchObject({ status: "pending", payment_status: "paid" })
    expect(m.db.tables.hubtel_data_orders[0].failure_reason).toBeUndefined()
  })

  it("a charge answered 'failed' is treated like a throw", async () => {
    const m = make({ chargeStatus: "failed" })
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    expect(r).toMatchObject({ ok: false, code: "CHARGE_FAILED" })
    expect(m.db.tables.wallet_payments[0].status).toBe("failed")
    expectGuardedFail(m, "hubtel_data_orders", "d1")
  })

  it("wallet_payments insert error => CHARGE_FAILED, no charge, order failed (guarded)", async () => {
    const m = make({ insertError: { wallet_payments: { code: "23502", message: "null value" } } })
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    expect(r).toMatchObject({ ok: false, code: "CHARGE_FAILED" })
    expect(m.charges).toHaveLength(0)
    expectGuardedFail(m, "hubtel_data_orders", "d1")
  })

  it("an OTP pointer write failure does not fail the charge", async () => {
    const m = make({ chargeStatus: "send_otp" })
    m.deps.otpPointer.set = vi.fn(async () => { throw new Error("redis down") })
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    expect(r).toMatchObject({ ok: true, status: "send_otp" })
  })
})

describe("submitBotOtp", () => {
  async function charged(otp: { otpStatus?: string; otpThrows?: boolean } = {}) {
    const m = make({ chargeStatus: "send_otp", ...otp })
    const r = await botChargeMomo(m.deps, SHOP_BUNDLE)
    if (!r.ok) throw new Error("expected ok")
    const p = m.pointers.get("0241234567")!
    expect(p).toBeDefined()
    return { m, p, reference: r.reference }
  }

  it("submits the OTP for the pointer's reference and clears the pointer", async () => {
    const { m, p, reference } = await charged()
    const out = await submitBotOtp(m.deps, p, "123456")
    expect(out).toEqual({ ok: true })
    expect(m.deps.submitOtp).toHaveBeenCalledWith(reference, "123456")
    expect(m.deps.otpPointer.clear).toHaveBeenCalledWith("0241234567")
    expect(m.pointers.size).toBe(0)
    expect(m.db.tables.hubtel_data_orders[0]).toMatchObject({ status: "pending", payment_status: "unpaid" })
    expect(m.db.tables.wallet_payments[0].status).toBe("pending")
  })

  it("a rejected OTP ('failed') fails the payment row and the order (guarded) and clears the pointer", async () => {
    const { m, p } = await charged({ otpStatus: "failed" })
    const out = await submitBotOtp(m.deps, p, "000000")
    expect(out).toEqual({ ok: false })
    expect(m.db.tables.wallet_payments[0].status).toBe("failed")
    expectGuardedFail(m, "hubtel_data_orders", "d1")
    expect(m.db.tables.hubtel_data_orders[0]).toMatchObject({ status: "failed", payment_status: "unpaid" })
    expect(m.pointers.size).toBe(0)
  })

  it("a rejected OTP never touches an order that is already paid", async () => {
    const { m, p } = await charged({ otpStatus: "failed" })
    Object.assign(m.db.tables.hubtel_data_orders[0], { payment_status: "paid" })
    await submitBotOtp(m.deps, p, "000000")
    expect(m.db.tables.hubtel_data_orders[0]).toMatchObject({ status: "pending", payment_status: "paid" })
  })

  it("a submit error leaves the order alone (the charge may still complete) and clears the pointer", async () => {
    const { m, p } = await charged({ otpThrows: true })
    const out = await submitBotOtp(m.deps, p, "123456")
    expect(out).toEqual({ ok: false })
    expect(m.db.tables.hubtel_data_orders[0]).toMatchObject({ status: "pending", payment_status: "unpaid" })
    expect(m.db.tables.wallet_payments[0].status).toBe("pending")
    expect(m.pointers.size).toBe(0)
  })
})
