// confirmShopBundleByText: the text-to-buy shop line's data confirm. Every collaborator is injected, so nothing here
// touches a database, a gateway or the network. The real ussdOrderAmount runs (against an injected gateway config) so
// the price guarantee is tested on the real fee logic.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { confirmShopBundleByText, type ConfirmShopDeps, type ConfirmShopInput } from "./confirm-by-text"
import { ussdOrderAmount } from "@/lib/ussd/gateway-charge"

const SENDER = "0200000101"
const RECIPIENT = "0200000102"

const h = {
  scheduled: [] as Array<() => Promise<void>>,
  created: [] as any[],
  charges: [] as any[],
  store: { recordCharge: vi.fn(), markOtpRequired: vi.fn(), markFailed: vi.fn() },
  reprice: vi.fn(),
}

function config(gateway: "paystack" | "hubtel") {
  return { version: 1, surfaces: { sms_order: { gateway, mode: "direct", feeBearer: "customer" } }, hubtelFeePercent: 2 } as any
}

function makeDeps(over: Partial<ConfirmShopDeps> & { gateway?: "paystack" | "hubtel"; price?: number; parent?: boolean; fee?: number } = {}): ConfirmShopDeps {
  const gateway = over.gateway ?? "paystack"
  const price = over.price ?? 10
  const deps: ConfirmShopDeps = {
    resolveShopCode: async () => ({ status: "active", shopId: "shop1", parentShopId: over.parent ? "parent1" : null }),
    dataBlocked: async () => false,
    prefixAllowed: async () => true,
    recipientBlocked: async () => false,
    loadBundle: async () => ({ network: "MTN", size: "1GB" }),
    verifyBundlePrice: async () => ({ verifiedPrice: price, profitAmount: 1.5, parentProfitAmount: over.parent ? 0.5 : 0 }),
    paystackFeePercent: async () => over.fee ?? 3,
    orderAmount: (surface, payer, p) => ussdOrderAmount(surface, payer, p, { getConfig: async () => config(gateway), isReady: () => true }),
    orderContext: async () => ({ shopName: "Ama Data", customerEmail: "c@example.com", shopOwnerEmail: "o@example.com" }),
    createShopBundleOrder: async (i) => { h.created.push(i); return { orderId: "order-1" } },
    startUssdCharge: async (i) => { h.charges.push(i); return { status: "pay_offline", amount: i.written } as any },
    reprice: (orderId, from, to) => { h.reprice(orderId, from, to); return async () => true },
    schedule: (fn) => { h.scheduled.push(fn) },
    store: h.store as any,
  }
  const { gateway: _g, price: _p, parent: _pa, fee: _f, ...rest } = over
  return { ...deps, ...rest }
}

const input = (over: Partial<ConfirmShopInput> = {}): ConfirmShopInput => ({
  shopCodeId: "code1", shopId: "shop1", parentShopId: null, paystackProvider: "vod", bundleId: "p1",
  recipientLocal: RECIPIENT, senderLocal: SENDER, messageId: "m1", ...over,
})

/** Runs the scheduled after-response work WITHOUT advancing timers: hangs (test times out) if any wait remains. */
async function runScheduled() {
  const fns = h.scheduled.splice(0)
  await Promise.all(fns.map((f) => f()))
}

beforeEach(() => {
  vi.useFakeTimers()
  h.scheduled = []
  h.created = []
  h.charges = []
  for (const f of [h.store.recordCharge, h.store.markOtpRequired, h.store.markFailed, h.reprice]) f.mockReset()
})

describe("confirmShopBundleByText: placing the order", () => {
  it("writes a shop order on the sms_shop channel and returns its id and the amount written", async () => {
    const r = await confirmShopBundleByText(input(), makeDeps())
    expect(r.orderId).toBe("order-1")
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      shopCodeId: "code1", shopId: "shop1", parentShopId: null, dialingPhone: SENDER, recipientPhone: RECIPIENT,
      network: "MTN", paystackProvider: "vod", bundleId: "p1", bundleSize: "1GB", verifiedPrice: 10, profitAmount: 1.5,
      parentProfitAmount: 0, shopName: "Ama Data", customerEmail: "c@example.com", shopOwnerEmail: "o@example.com",
      channel: "sms_shop",
    })
    expect(h.created[0].chargeAmount).toBeCloseTo(10.3, 2)
    expect(r.amountGhs).toBe(h.created[0].chargeAmount)
  })

  it("a sub-agent shop carries the parent id and the parent's profit onto the row", async () => {
    await confirmShopBundleByText(input({ parentShopId: "parent1" }), makeDeps({ parent: true }))
    expect(h.created[0]).toMatchObject({ parentShopId: "parent1", profitAmount: 1.5, parentProfitAmount: 0.5 })
  })

  it("a Hubtel-priced shop order is written without the Paystack fee", async () => {
    const r = await confirmShopBundleByText(input(), makeDeps({ gateway: "hubtel" }))
    expect(r.amountGhs).toBe(10)
    expect(h.created[0].chargeAmount).toBe(10)
  })

  it("passes the sms_order surface to the fee function", async () => {
    const orderAmount = vi.fn(async (_s: any, _p: boolean, p: any) => p.paystack)
    await confirmShopBundleByText(input(), makeDeps({ orderAmount }))
    expect(orderAmount).toHaveBeenCalledWith("sms_order", true, expect.objectContaining({ hubtel: 10 }))
  })

  it("verifiedPayer is false when the sender's number is not on the provider's network", async () => {
    const orderAmount = vi.fn(async (_s: any, _p: boolean, p: any) => p.paystack)
    await confirmShopBundleByText(input({ paystackProvider: "mtn" }), makeDeps({ orderAmount }))
    expect(orderAmount.mock.calls[0][1]).toBe(false)
  })
})

describe("confirmShopBundleByText: refusals write nothing", () => {
  const refused = async (deps: ConfirmShopDeps, i: ConfirmShopInput = input()) => {
    const r = await confirmShopBundleByText(i, deps)
    expect(r.orderId).toBeUndefined()
    expect(r.amountGhs).toBeUndefined()
    expect(h.created).toHaveLength(0)
    expect(h.scheduled).toHaveLength(0)
    expect(h.charges).toHaveLength(0)
  }

  it.each(["inactive", "suspended", "pending", ""])("a shop whose code resolves to status %j", async (status) => {
    await refused(makeDeps({ resolveShopCode: async () => ({ status, shopId: "shop1", parentShopId: null }) }))
  })
  it("a code that no longer resolves", async () => { await refused(makeDeps({ resolveShopCode: async () => null })) })
  it("a resolver that throws", async () => { await refused(makeDeps({ resolveShopCode: async () => { throw new Error("db") } })) })
  it("a code that now belongs to another shop", async () => {
    await refused(makeDeps({ resolveShopCode: async () => ({ status: "active", shopId: "shopX", parentShopId: null }) }))
  })
  it("a parent that changed since the offer", async () => {
    await refused(makeDeps({ resolveShopCode: async () => ({ status: "active", shopId: "shop1", parentShopId: "other" }) }), input({ parentShopId: "parent1" }))
  })
  it("the data whitelist blocks the sender", async () => { await refused(makeDeps({ dataBlocked: async () => true })) })
  it("a whitelist check that throws", async () => { await refused(makeDeps({ dataBlocked: async () => { throw new Error("db") } })) })
  it("a recipient on the wrong network prefix", async () => { await refused(makeDeps({ prefixAllowed: async () => false })) })
  it("an MTN recipient the verification gate blocks", async () => { await refused(makeDeps({ recipientBlocked: async () => true })) })
  it("a package that is gone", async () => { await refused(makeDeps({ loadBundle: async () => null })) })
  it("a bundle the shop no longer offers", async () => { await refused(makeDeps({ verifyBundlePrice: async () => null })) })
  it.each([NaN, 0, -1, Infinity])("an unusable verified price %s", async (verifiedPrice) => {
    await refused(makeDeps({ verifyBundlePrice: async () => ({ verifiedPrice, profitAmount: 1, parentProfitAmount: 0 }) }))
  })
  it("an unusable profit snapshot", async () => {
    await refused(makeDeps({ verifyBundlePrice: async () => ({ verifiedPrice: 10, profitAmount: NaN, parentProfitAmount: 0 }) }))
  })
  it("an order that cannot be written", async () => {
    const r = await confirmShopBundleByText(input(), makeDeps({ createShopBundleOrder: async () => ({ error: "insert failed" }) }))
    expect(r).toEqual({})
    expect(h.scheduled).toHaveLength(0)
  })
  it("an order write that throws", async () => {
    const r = await confirmShopBundleByText(input(), makeDeps({ createShopBundleOrder: async () => { throw new Error("boom") } }))
    expect(r).toEqual({})
    expect(h.scheduled).toHaveLength(0)
  })

  it("re-checks the shop status immediately before the order is written, after pricing", async () => {
    const order: string[] = []
    await confirmShopBundleByText(input(), makeDeps({
      resolveShopCode: async () => { order.push("resolve"); return { status: "active", shopId: "shop1", parentShopId: null } },
      verifyBundlePrice: async () => { order.push("verify"); return { verifiedPrice: 10, profitAmount: 1, parentProfitAmount: 0 } },
      createShopBundleOrder: async () => { order.push("create"); return { orderId: "o" } },
    }))
    expect(order).toEqual(["verify", "resolve", "create"])
  })
})

describe("confirmShopBundleByText: the charge", () => {
  it("charges the sender on sms_order with no wait, no wallet, and nothing the recipient could be billed", async () => {
    await confirmShopBundleByText(input(), makeDeps())
    expect(h.scheduled).toHaveLength(1)
    expect(h.charges).toHaveLength(0) // nothing charged inside the request
    await runScheduled() // timers NOT advanced
    expect(h.charges).toHaveLength(1)
    const c = h.charges[0]
    expect(c.surface).toBe("sms_order")
    expect(c.verifiedPayer).toBe(true)
    expect(c.params.phone).toBe(SENDER)
    expect(c.params.phone).not.toBe(RECIPIENT)
    expect(c.params.reference).toBe("order-1")
    expect(c.params.provider).toBe("vod")
    expect(c.params.metadata).toMatchObject({ source: "sms_shop", ussd_shop_order_id: "order-1", recipient_phone: RECIPIENT, shop_id: "shop1" })
    expect(c.written).toBe(h.created[0].chargeAmount)
    expect(c.price.hubtel).toBe(10)
  })

  it("the reprice hook moves the shop order from the written amount to the Paystack price", async () => {
    await confirmShopBundleByText(input(), makeDeps({ gateway: "hubtel" }))
    await runScheduled()
    const c = h.charges[0]
    expect(c.written).toBe(10)
    await c.reprice()
    expect(h.reprice).toHaveBeenCalledWith("order-1", 10, c.price.paystack)
  })

  it("records the attempt and the reference after a started charge", async () => {
    await confirmShopBundleByText(input(), makeDeps())
    await runScheduled()
    expect(h.store.recordCharge).toHaveBeenCalledTimes(1)
    expect(h.store.recordCharge).toHaveBeenCalledWith("order-1", { amount: h.created[0].chargeAmount, email: "c@example.com" })
    expect(h.store.markOtpRequired).not.toHaveBeenCalled()
    expect(h.store.markFailed).not.toHaveBeenCalled()
  })

  it("send_otp marks the order otp_required and sends nothing", async () => {
    await confirmShopBundleByText(input(), makeDeps({ startUssdCharge: async (i) => ({ status: "send_otp", amount: i.written } as any) }))
    await runScheduled()
    expect(h.store.markOtpRequired).toHaveBeenCalledWith("order-1")
    expect(h.store.markFailed).not.toHaveBeenCalled()
  })

  it("a charge that cannot be scheduled closes the order and returns no order id", async () => {
    const r = await confirmShopBundleByText(input(), makeDeps({ schedule: () => { throw new Error("outside a request") } }))
    expect(r).toEqual({})
    expect(h.store.markFailed).toHaveBeenCalledWith("order-1")
    expect(h.charges).toHaveLength(0)
  })

  it("a charge that throws fails the order", async () => {
    await confirmShopBundleByText(input(), makeDeps({ startUssdCharge: async () => { throw new Error("Paystack charge failed") } }))
    await runScheduled()
    expect(h.store.markFailed).toHaveBeenCalledWith("order-1")
  })
})

// The quote the customer is sent is the returned amountGhs, so it must be exactly what the order row says and what the
// charge asks for first, across every price/fee/gateway/shop-type combination.
describe("price guarantee: amountGhs equals the amount charged", () => {
  const prices = [1, 4.5, 9.99, 10, 12.34, 55, 100.01, 250]
  const fees = [0, 1.5, 3, 4.75]
  const gateways = ["paystack", "hubtel"] as const
  const shops = [{ name: "direct", parent: false }, { name: "sub-agent", parent: true }]

  for (const s of shops) for (const gateway of gateways) {
    it(`${s.name} shop, ${gateway}: returned amount === row amount === first charge amount`, async () => {
      for (const price of prices) for (const fee of fees) {
        h.created = []; h.charges = []
        const r = await confirmShopBundleByText(
          input({ parentShopId: s.parent ? "parent1" : null }),
          makeDeps({ gateway, price, fee, parent: s.parent }),
        )
        await runScheduled()
        const paystack = price + Math.round(price * (fee / 100) * 100) / 100
        expect(r.amountGhs).toBeDefined()
        expect(h.created).toHaveLength(1)
        expect(r.amountGhs).toBe(h.created[0].chargeAmount)
        expect(h.charges).toHaveLength(1)
        expect(h.charges[0].written).toBe(r.amountGhs)
        expect(h.charges[0].params.amount).toBeUndefined() // startUssdCharge sets the amount from `written`
        // The amount is one of the two prices, never anything else.
        const allowed = gateway === "hubtel" && Math.round(price * 100) < Math.round(paystack * 100) ? price : paystack
        expect(r.amountGhs).toBeCloseTo(allowed, 2)
        // Order carries the shop price untouched; only `amount` varies with the gateway.
        expect(h.created[0].verifiedPrice).toBe(price)
      }
    })
  }

  it("a sender whose number is not on the paying network is always priced on Paystack", async () => {
    const r = await confirmShopBundleByText(input({ paystackProvider: "mtn" }), makeDeps({ gateway: "hubtel" }))
    expect(r.amountGhs).toBeCloseTo(10.3, 2)
  })
})
