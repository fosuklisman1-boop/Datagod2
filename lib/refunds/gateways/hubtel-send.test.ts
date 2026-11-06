import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RefundableOrder, RefundContext } from "../types"

const sendMoney = vi.fn()
const checkSendStatus = vi.fn()
vi.mock("../hubtel-send-client", async (orig) => ({
  ...(await orig<typeof import("../hubtel-send-client")>()),
  sendMoney: (...a: unknown[]) => sendMoney(...a),
  checkSendStatus: (...a: unknown[]) => checkSendStatus(...a),
}))
vi.mock("@/lib/moolre-transfer", () => ({ initiateTransfer: vi.fn(), getTransferStatus: vi.fn() }))
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: vi.fn() }))
vi.mock("@/lib/paystack-transfer", () => ({
  createRecipient: vi.fn(), initiateTransfer: vi.fn(), finalizeTransfer: vi.fn(), getTransferStatus: vi.fn(),
  mapNetworkToPaystackBankCode: (n: string) => ({ MTN: "MTN", TELECEL: "VOD", AT: "ATL" } as Record<string, string>)[n.toUpperCase()],
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: vi.fn() }) }))

import { hubtelSendGateway } from "./hubtel-send"
import { getGateway, listGateways, supportOf } from "./index"

const RF = "3F2504E0-4F89-41D3-9A0C-0305E82C3301"

const baseOrder = (o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "shop_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: null, shopName: null, packageLabel: "2", network: "MTN", recipientPhone: "0245550102",
  createdAt: "2026-11-05", paid: 10, gatewayFee: 0,
  payment: { gateway: "paystack", reference: "ref-1", payerPhone: "0245550101", walletUserId: null },
  owners: [], evidence: { hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null },
  ...o,
})
const attemptOf = (a: Record<string, unknown> = {}) => ({
  status: "paid", paidAttempts: 1, msisdn: "233245550101", channel: "mtn-gh", requestedPesewas: 1000, paymentMethod: "mobilemoney", ...a,
})
const hubtelOrder = (a: Record<string, unknown> = {}, o: Partial<RefundableOrder> = {}, pay: Record<string, unknown> = {}): RefundableOrder =>
  baseOrder({
    payment: { gateway: "hubtel", reference: null, payerPhone: "0245550101", walletUserId: null, hubtelCollection: true, hubtelAttempt: attemptOf(a), ...pay } as any,
    ...o,
  })
const ctx = (order: RefundableOrder, amount = 10, dest: string | null = "0245550101"): RefundContext => ({ refundId: RF, order, amount, destinationPhone: dest })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("HUBTEL_SEND_REFUNDS_ENABLED", "true")
})
afterEach(() => vi.unstubAllEnvs())

describe("registry placement", () => {
  it("hubtel_send is first (the dialog pre-selects the first supported gateway) and manual stays last", () => {
    const ids = listGateways().map((g) => g.id)
    expect(ids[0]).toBe("hubtel_send")
    expect(ids.at(-1)).toBe("manual")
    expect(getGateway("hubtel_send")).toBe(hubtelSendGateway)
    expect(hubtelSendGateway.label).toBe("Hubtel (MoMo payout to payer)")
  })
})

describe("hubtel_send supports()", () => {
  it("accepts a paid mobile money Hubtel collection with a valid payer number", () => {
    expect(hubtelSendGateway.supports(hubtelOrder())).toEqual({ ok: true })
  })
  it.each([undefined, "", "false", "TRUE", "1", "yes"])("refuses unless the switch is exactly true (%j)", (v) => {
    if (v === undefined) vi.stubEnv("HUBTEL_SEND_REFUNDS_ENABLED", undefined as any)
    else vi.stubEnv("HUBTEL_SEND_REFUNDS_ENABLED", v)
    const r = hubtelSendGateway.supports(hubtelOrder())
    expect(r.ok).toBe(false)
  })
  it("refuses an order that is not a Hubtel collection", () => {
    expect(hubtelSendGateway.supports(baseOrder()).ok).toBe(false)
  })
  it.each(["pending", "confirming", "needs_review", "failed"])("refuses an attempt that is %s", (status) => {
    expect(hubtelSendGateway.supports(hubtelOrder({ status })).ok).toBe(false)
  })
  it("refuses when two attempts were paid", () => {
    const r = hubtelSendGateway.supports(hubtelOrder({ paidAttempts: 2 }))
    expect(r.ok).toBe(false)
  })
  it.each(["card", "Card", "visa-card", null, undefined, "bank"])("refuses payment method %j", (paymentMethod) => {
    expect(hubtelSendGateway.supports(hubtelOrder({ paymentMethod })).ok).toBe(false)
  })
  it.each(["mobilemoney", "momo", "gmoney"])("accepts payment method %s", (paymentMethod) => {
    expect(hubtelSendGateway.supports(hubtelOrder({ paymentMethod })).ok).toBe(true)
  })
  it("refuses without a payer number, or one that is not a MoMo network", () => {
    expect(hubtelSendGateway.supports(hubtelOrder({}, {}, { payerPhone: null })).ok).toBe(false)
    expect(hubtelSendGateway.supports(hubtelOrder({}, {}, { payerPhone: "0115550101" })).ok).toBe(false)
    expect(hubtelSendGateway.supports(hubtelOrder({}, {}, { payerPhone: "12345" })).ok).toBe(false)
  })
  it("refuses a missing requested amount", () => {
    expect(hubtelSendGateway.supports(hubtelOrder({ requestedPesewas: null })).ok).toBe(false)
    expect(hubtelSendGateway.supports(hubtelOrder({ requestedPesewas: 0 })).ok).toBe(false)
  })
  it("refuses wallet-only tables", () => {
    expect(hubtelSendGateway.supports(hubtelOrder({}, { table: "orders" })).ok).toBe(false)
    expect(hubtelSendGateway.supports(hubtelOrder({}, { table: "api_orders" })).ok).toBe(false)
  })
  it("the refusal reasons never contain a phone number", () => {
    const r = hubtelSendGateway.supports(hubtelOrder({ status: "pending" }))
    expect(JSON.stringify(r)).not.toMatch(/\d{9}/)
  })
})

describe("hubtel_send maxAmount", () => {
  it("is the requested amount (handler amount when set), never Hubtel's gross", () => {
    expect(hubtelSendGateway.maxAmount?.(hubtelOrder({ requestedPesewas: 1000 }))).toBe(10)
    expect(hubtelSendGateway.maxAmount?.(hubtelOrder({ requestedPesewas: 1234 }))).toBe(12.34)
  })
  it("is null for an order that is not a Hubtel collection", () => {
    expect(hubtelSendGateway.maxAmount?.(baseOrder())).toBeNull()
  })
})

describe("hubtel_send refund()", () => {
  it("sends the destination as 233 msisdn on the stored channel, with the refund id", async () => {
    sendMoney.mockResolvedValue({ kind: "pending", ref: "tx1" })
    const out = await hubtelSendGateway.refund(ctx(hubtelOrder({ channel: "mtn-gh" }), 9.5))
    expect(out).toEqual({ kind: "pending", ref: "tx1" })
    expect(sendMoney).toHaveBeenCalledTimes(1)
    expect(sendMoney.mock.calls[0][0]).toEqual({ refundId: RF, msisdn: "233245550101", channel: "mtn-gh", amount: 9.5 })
  })
  it("prefers the channel the payer paid on (a ported number), falling back to the prefix", async () => {
    sendMoney.mockResolvedValue({ kind: "pending", ref: "t" })
    await hubtelSendGateway.refund(ctx(hubtelOrder({ channel: "vodafone-gh" })))
    expect(sendMoney.mock.calls[0][0].channel).toBe("vodafone-gh")
    sendMoney.mockClear()
    // no stored channel: the paying number's prefix
    await hubtelSendGateway.refund(ctx(hubtelOrder({ channel: null }), 5))
    expect(sendMoney.mock.calls[0][0]).toMatchObject({ msisdn: "233245550101", channel: "mtn-gh" })
  })
  it("passes unknown and completed outcomes straight through", async () => {
    sendMoney.mockResolvedValue({ kind: "unknown", error: "timeout" })
    expect(await hubtelSendGateway.refund(ctx(hubtelOrder()))).toEqual({ kind: "unknown", error: "timeout" })
    sendMoney.mockResolvedValue({ kind: "completed", ref: "t2" })
    expect(await hubtelSendGateway.refund(ctx(hubtelOrder()))).toEqual({ kind: "completed", ref: "t2" })
  })
  it("refuses an amount above what we requested, sending nothing", async () => {
    const out = await hubtelSendGateway.refund(ctx(hubtelOrder({ requestedPesewas: 1000 }), 10.01))
    expect(out.kind).toBe("failed")
    expect(sendMoney).not.toHaveBeenCalled()
  })
  it("accepts the full requested amount and a partial one", async () => {
    sendMoney.mockResolvedValue({ kind: "pending", ref: "t" })
    await hubtelSendGateway.refund(ctx(hubtelOrder({ requestedPesewas: 1000 }), 10))
    await hubtelSendGateway.refund(ctx(hubtelOrder({ requestedPesewas: 1000 }), 0.5))
    expect(sendMoney).toHaveBeenCalledTimes(2)
  })
  it("the cap is the handler amount when it differs from the gross requested", async () => {
    // requestedPesewas already carries handler ?? amount; 9.80 requested must not allow 10.00
    const out = await hubtelSendGateway.refund(ctx(hubtelOrder({ requestedPesewas: 980 }), 10))
    expect(out.kind).toBe("failed")
    expect(sendMoney).not.toHaveBeenCalled()
  })
  it.each([0, -1, NaN, 1.005])("rejects amount %s without sending", async (amount) => {
    expect((await hubtelSendGateway.refund(ctx(hubtelOrder(), amount))).kind).toBe("failed")
    expect(sendMoney).not.toHaveBeenCalled()
  })
  it("re-checks the switch at send time", async () => {
    vi.stubEnv("HUBTEL_SEND_REFUNDS_ENABLED", "false")
    expect((await hubtelSendGateway.refund(ctx(hubtelOrder()))).kind).toBe("failed")
    expect(sendMoney).not.toHaveBeenCalled()
  })
  it.each([
    ["no Hubtel facts", baseOrder()],
    ["an attempt that is not paid", hubtelOrder({ status: "pending" })],
    ["two paid attempts", hubtelOrder({ paidAttempts: 2 })],
    ["a card payment", hubtelOrder({ paymentMethod: "card" })],
  ])("sends nothing for %s", async (_n, order) => {
    expect((await hubtelSendGateway.refund(ctx(order))).kind).toBe("failed")
    expect(sendMoney).not.toHaveBeenCalled()
  })
  it("sends nothing without a valid destination", async () => {
    for (const dest of [null, "", "0115550101", "abc"]) {
      expect((await hubtelSendGateway.refund(ctx(hubtelOrder(), 5, dest))).kind).toBe("failed")
    }
    expect(sendMoney).not.toHaveBeenCalled()
  })
  it("never leaks the msisdn into an outcome message", async () => {
    const out = await hubtelSendGateway.refund(ctx(hubtelOrder({ requestedPesewas: 100 }), 5, "0245550101"))
    expect(JSON.stringify(out)).not.toMatch(/245550101/)
  })
})

// A Hubtel payout goes only to the number that paid: a number on the order row may be the dialler, not the payer.
describe("hubtel_send pays only the number that paid", () => {
  it("refuses an attempt with no stored number (e.g. hosted checkout), even if the order row has one", () => {
    const s = hubtelSendGateway.supports(hubtelOrder({ msisdn: null }))
    expect(s.ok).toBe(false)
  })
  it("sends nothing to a destination other than the paying number", async () => {
    const out = await hubtelSendGateway.refund(ctx(hubtelOrder(), 10, "0245550199"))
    expect(out.kind).toBe("failed")
    expect(sendMoney).not.toHaveBeenCalled()
  })
  it("the same number in another format is still the paying number", async () => {
    sendMoney.mockResolvedValueOnce({ kind: "pending", ref: "t1" })
    await hubtelSendGateway.refund(ctx(hubtelOrder(), 10, "+233245550101"))
    expect(sendMoney).toHaveBeenCalledTimes(1)
  })
})

describe("an order with two paid Hubtel attempts", () => {
  it("offers manual only: which payment to return needs a person", () => {
    const order = hubtelOrder({ paidAttempts: 2, msisdn: null, channel: null, requestedPesewas: null, paymentMethod: null })
    const offered = listGateways().filter((g) => supportOf(g, order).ok).map((g) => g.id)
    expect(offered).toEqual(["manual"])
  })
})

describe("hubtel_send checkStatus()", () => {
  it("looks up by refund id and amount, even when the switch is off", async () => {
    vi.stubEnv("HUBTEL_SEND_REFUNDS_ENABLED", "false")
    checkSendStatus.mockResolvedValue({ kind: "completed", ref: "t9" })
    const out = await hubtelSendGateway.checkStatus!(ctx(hubtelOrder(), 7.25), "tx1")
    expect(out).toEqual({ kind: "completed", ref: "t9" })
    expect(checkSendStatus).toHaveBeenCalledWith({ refundId: RF, amount: 7.25 })
  })
})

describe("gateways offered on a Hubtel-paid order", () => {
  const offered = (o: RefundableOrder) => listGateways().filter((g) => supportOf(g, o).ok).map((g) => g.id)

  it("is hubtel_send, moolre, paystack_payout and manual (wallet only where it applies); never Paystack reversal or the Hubtel refund API", () => {
    expect(offered(hubtelOrder())).toEqual(["hubtel_send", "paystack_payout", "moolre", "manual"])
  })
  it("adds the wallet where a proving wallet user exists", () => {
    expect(offered(hubtelOrder({}, {}, { walletUserId: "u1" }))).toEqual(["hubtel_send", "paystack_payout", "moolre", "wallet", "manual"])
  })
  it("with the switch off the other payouts still work for a paid attempt", () => {
    vi.stubEnv("HUBTEL_SEND_REFUNDS_ENABLED", "false")
    expect(offered(hubtelOrder())).toEqual(["paystack_payout", "moolre", "manual"])
  })
  it("Paystack reversal is refused with a reason even if a stale Paystack reference leaks onto the order", () => {
    const o = hubtelOrder({}, {}, { reference: "ref-1" })
    const paystack = getGateway("paystack")!
    const s = supportOf(paystack, o)
    expect(s.ok).toBe(false)
    expect(supportOf(getGateway("hubtel")!, o).ok).toBe(false)
  })
})

describe("Paystack-paid orders are offered exactly what they are today", () => {
  const offered = (o: RefundableOrder) => listGateways().filter((g) => supportOf(g, o).ok).map((g) => g.id)
  const paystackOrder = (o: Partial<RefundableOrder> = {}) =>
    baseOrder({ table: "ussd_orders", payment: { gateway: "paystack", reference: "ref-1", payerPhone: "0245550101", walletUserId: null }, ...o })

  it("a ussd order with a payer number: Paystack reversal, both payouts, manual", () => {
    expect(offered(paystackOrder())).toEqual(["paystack", "paystack_payout", "moolre", "manual"])
  })
  it("with a wallet user the wallet joins", () => {
    expect(offered(paystackOrder({ payment: { gateway: "paystack", reference: "ref-1", payerPhone: "0245550101", walletUserId: "u1" } }))).toEqual(["paystack", "paystack_payout", "moolre", "wallet", "manual"])
  })
  it("hubtel_send is never offered, even with the switch on", () => {
    expect(supportOf(hubtelSendGateway, paystackOrder()).ok).toBe(false)
  })
  it("a wallet-only order offers the wallet and manual only", () => {
    const o = baseOrder({ table: "orders", payment: { gateway: "wallet", reference: null, payerPhone: null, walletUserId: "u1" } })
    expect(offered(o)).toEqual(["wallet", "manual"])
  })
  it("a no-payer-number order offers Paystack reversal and manual only", () => {
    expect(offered(paystackOrder({ payment: { gateway: "paystack", reference: "ref-1", payerPhone: null, walletUserId: null } }))).toEqual(["paystack", "manual"])
  })
})

describe("payouts on a Hubtel-paid order go only to the number that paid (I2)", () => {
  const moolre = () => getGateway("moolre")!
  const payout = () => getGateway("paystack_payout")!

  it("a hosted payment has no recorded number: payouts refused; wallet and manual stay available", () => {
    const o = hubtelOrder({ msisdn: null, channel: null }, {}, { payerPhone: "0245550199", walletUserId: "u1" })
    for (const g of [moolre(), payout(), hubtelSendGateway]) {
      const s = supportOf(g, o)
      expect(s.ok).toBe(false)
      if (!s.ok) expect(s.reason).not.toMatch(/\d{7,}/)
    }
    expect(supportOf(getGateway("wallet")!, o).ok).toBe(true)
    expect(supportOf(getGateway("manual")!, o).ok).toBe(true)
  })
  it("a destination other than the paying number is refused", () => {
    const o = hubtelOrder({}, {}, { payerPhone: "0245550199" })
    expect(supportOf(moolre(), o).ok).toBe(false)
    expect(supportOf(payout(), o).ok).toBe(false)
  })
  it("the paying number, in any format, is allowed", () => {
    const o = hubtelOrder({ msisdn: "233245550101" }, {}, { payerPhone: "0245550101" })
    expect(supportOf(moolre(), o).ok).toBe(true)
    expect(supportOf(payout(), o).ok).toBe(true)
  })
  it("a Paystack-paid order is unchanged", () => {
    expect(supportOf(moolre(), baseOrder()).ok).toBe(true)
    expect(supportOf(payout(), baseOrder()).ok).toBe(true)
  })
})

describe("payouts are capped at what was requested from Hubtel (M2)", () => {
  it("moolre and paystack_payout cap a Hubtel-paid order; a Paystack-paid one has no cap", () => {
    for (const id of ["moolre", "paystack_payout"]) {
      const g = getGateway(id)!
      expect(g.maxAmount?.(hubtelOrder({ requestedPesewas: 980 }))).toBe(9.8)
      expect(g.maxAmount?.(baseOrder()) ?? null).toBeNull()
    }
  })
})
