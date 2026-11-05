// botChargeMomo (commission bots: Uzo Network Plans / Pay Bills, and the WhatsApp bots) with the REAL startMomoCharge.
// Bill order: face 20, paid_amount 20.22 including a 0.22 Paystack payment fee; Hubtel charges 20.00.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("@/lib/cashback/config", async (orig) => ({
  ...(await orig<object>()),
  getCashbackConfig: vi.fn(async () => ({
    enabled: true, surfaces: { bots: true }, botGroups: { bills: true, bundles: true },
    botFees: { paystack: { bills: 1.1, bundles: 0.3 }, hubtel: {} }, paymentFee: {},
  })),
}))

import { botChargeMomo, type BotMomoDeps } from "./momo"
import { getGatewayConfig } from "@/lib/payment-gateway/read-config"
import { isHubtelCollectionReady } from "@/lib/payment-gateway/hubtel-readiness"
import { fakeClient, gatewayConfig, hubtelRows, kit, resetKit, rows } from "@/lib/ussd/gateway-test-kit"

const DIAL = "233241234567"
const NOW = Date.parse("2026-11-05T10:00:00Z")

function make(o: { gateway?: boolean } = {}) {
  const deferred: Array<() => Promise<void>> = []
  const charge = vi.fn(async (p: any) => ({ status: "pay_offline", reference: p.reference }))
  const deps: BotMomoDeps = {
    db: fakeClient as any,
    chargeMobileMoney: charge as any,
    submitOtp: vi.fn() as any,
    recordPayerPhone: vi.fn(async () => {}) as any,
    rateLimit: vi.fn(async () => true),
    otpPointer: { set: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
    payerOtp: { required: vi.fn(async () => false), verified: vi.fn(async () => false) },
    now: () => NOW,
    defer: (fn) => { deferred.push(fn) },
    ...(o.gateway === false ? {} : { gateway: { getConfig: getGatewayConfig, isReady: isHubtelCollectionReady } }),
  }
  const flush = async () => { for (const f of deferred.splice(0)) await f() }
  return { deps, charge, deferred, flush }
}

const input = (over: any = {}) => ({ orderType: "cs_bill" as const, orderId: "b1", botSurface: "ussd" as const, shopId: null, dialingPhone: DIAL, ...over })
const order = () => rows("hubtel_bill_orders")[0]
const payment = () => rows("wallet_payments")[0]

beforeEach(() => {
  resetKit()
  kit.db.hubtel_bill_orders = [{
    id: "b1", channel: "bots", bot_surface: "ussd", shop_id: null, status: "pending", payment_status: "unpaid",
    amount: 20, paid_amount: 20.22, payment_fee_amount: 0.22, buyer_email: null, buyer_phone: DIAL,
  }]
})

describe("bot charge on Paystack (unchanged)", () => {
  it("charges paid_amount synchronously, nothing deferred, no order write", async () => {
    const m = make()
    const r = await botChargeMomo(m.deps, input())
    expect(r).toMatchObject({ ok: true, status: "pay_offline", promptedPhone: "0241234567" })
    expect(m.charge).toHaveBeenCalledTimes(1)
    expect(m.charge.mock.calls[0][0]).toMatchObject({ amount: 20.22, phone: "0241234567", provider: "mtn" })
    expect(m.deferred).toHaveLength(0)
    expect(payment()).toMatchObject({ amount: 20.22, payment_method: "paystack", fee: 0 })
    expect(kit.ops.filter(([t, op]) => t === "hubtel_bill_orders" && op === "update")).toHaveLength(0)
    expect(hubtelRows()).toHaveLength(0)
  })

  it("without gateway wiring (old deps) it is Paystack", async () => {
    kit.config = gatewayConfig(["ussd"])
    const m = make({ gateway: false })
    await botChargeMomo(m.deps, input())
    expect(m.charge).toHaveBeenCalledTimes(1)
    expect(kit.receive).not.toHaveBeenCalled()
  })

  it("a Paystack error still fails the order", async () => {
    const m = make()
    m.charge.mockImplementation(async () => { throw new Error("boom") })
    const r = await botChargeMomo(m.deps, input())
    expect(r).toMatchObject({ ok: false, code: "CHARGE_FAILED" })
    expect(order().status).toBe("failed")
  })
})

describe("bot charge on Hubtel", () => {
  beforeEach(() => { kit.config = gatewayConfig(["ussd", "whatsapp"]) })

  it("accepted: the reply is immediate (start deferred), the order and payment drop the Paystack fee", async () => {
    const m = make()
    const r = await botChargeMomo(m.deps, input())
    expect(r).toMatchObject({ ok: true, promptedPhone: "0241234567" })
    expect(kit.receive).not.toHaveBeenCalled() // not inside the USSD reply
    expect(order()).toMatchObject({ paid_amount: 20, payment_fee_amount: null })
    expect(payment()).toMatchObject({ amount: 20, payment_method: "hubtel" })
    await m.flush()
    expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233241234567", amount: 20 })
    expect(hubtelRows()[0]).toMatchObject({ internal_reference: payment().reference, surface: "ussd" })
    expect(m.charge).not.toHaveBeenCalled()
    expect(order().status).toBe("pending")
  })

  it("refused: Paystack at the fee-inclusive price, order and payment moved back first", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
    const m = make()
    let at: any
    m.charge.mockImplementation(async (p: any) => { at = { order: { ...order() }, payment: { ...payment() } }; return { status: "pay_offline", reference: p.reference } })
    await botChargeMomo(m.deps, input())
    await m.flush()
    expect(m.charge.mock.calls[0][0].amount).toBe(20.22)
    expect(at.order).toMatchObject({ paid_amount: 20.22, payment_fee_amount: 0.22 })
    expect(at.payment).toMatchObject({ amount: 20.22, payment_method: "paystack" })
  })

  it("refused and the order can't be moved back: nothing charged, order failed", async () => {
    kit.receive.mockImplementation(async () => {
      order().paid_amount = 25 // changed under us
      return { kind: "refused", code: "4000", message: "no" }
    })
    const m = make()
    await botChargeMomo(m.deps, input())
    await m.flush()
    expect(m.charge).not.toHaveBeenCalled()
    expect(order().status).toBe("failed")
  })

  it("unknown: order not failed, no Paystack", async () => {
    kit.receive.mockImplementation(async () => ({ kind: "unknown", code: "timeout", message: "slow" }))
    const m = make()
    await botChargeMomo(m.deps, input())
    await m.flush()
    expect(m.charge).not.toHaveBeenCalled()
    expect(order()).toMatchObject({ status: "pending", payment_status: "unpaid" })
    expect(payment().status).toBe("pending")
  })

  it("a repeat confirm replays the live payment: one prompt in total", async () => {
    const m = make()
    await botChargeMomo(m.deps, input())
    await m.flush()
    const again = await botChargeMomo(m.deps, input())
    await m.flush()
    expect(again).toMatchObject({ ok: true, status: "pending" })
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(rows("wallet_payments")).toHaveLength(1)
  })

  it("WhatsApp: a typed number that isn't the sender's stays on Paystack at the fee-inclusive price", async () => {
    kit.db.hubtel_bill_orders[0].bot_surface = "whatsapp"
    const m = make()
    await botChargeMomo(m.deps, input({ botSurface: "whatsapp", payPhone: "0551234567" }))
    expect(m.charge.mock.calls[0][0]).toMatchObject({ amount: 20.22, phone: "0551234567" })
    expect(kit.receive).not.toHaveBeenCalled()
  })

  it("WhatsApp: the sender's own number goes to Hubtel on the whatsapp surface", async () => {
    kit.db.hubtel_bill_orders[0].bot_surface = "whatsapp"
    const m = make()
    await botChargeMomo(m.deps, input({ botSurface: "whatsapp", payPhone: "0241234567" }))
    await m.flush()
    expect(hubtelRows()[0].surface).toBe("whatsapp")
  })

  it("an order left fee-free by an earlier Hubtel attempt gets its fee back before a Paystack charge", async () => {
    kit.config = gatewayConfig()
    Object.assign(order(), { paid_amount: 20, payment_fee_amount: null })
    const m = make()
    await botChargeMomo(m.deps, input())
    expect(order()).toMatchObject({ paid_amount: 20.22, payment_fee_amount: 0.22 })
    expect(m.charge.mock.calls[0][0].amount).toBe(20.22)
    expect(payment().amount).toBe(20.22)
  })
})
