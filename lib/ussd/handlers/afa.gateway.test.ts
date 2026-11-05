// Uzo AFA registration (handleAfaConfirm) with the REAL startMomoCharge. Price 50, Paystack fee 3%: Paystack 51.50,
// Hubtel 50.00. The prompt always goes to the dialler on the MTN provider (as today).
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ afterFns: [] as Array<() => Promise<void>>, charge: null as any, verified: new Set<string>() }))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
vi.mock("../session", () => ({ setSession: vi.fn(async () => {}) }))
vi.mock("../resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("@/lib/paystack", async (orig) => ({ ...(await orig<object>()), chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)) }))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({})) }))
vi.mock("@/lib/storefront-otp", async (orig) => ({
  ...(await orig<object>()),
  isPhoneOtpVerified: vi.fn(async (p: string) => h.verified.has(p)),
}))

import { handleAfaConfirm } from "./afa"
import { chargeMobileMoney } from "@/lib/paystack"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "../gateway-test-kit"

const session = (over: Record<string, unknown> = {}): any => ({
  step: "AFA_CONFIRM_AFA", afaFullName: "Ama Mensah", afaGhCard: "GHA-123456789-0", afaLocation: "Accra",
  afaRegion: "Greater Accra", afaPrice: 50, dialingPhone: "+233244123456", ...over,
})
async function runAfter() {
  const done = Promise.all(h.afterFns.splice(0).map((f) => f()))
  await vi.advanceTimersByTimeAsync(5000)
  await done
}
const order = () => rows("ussd_afa_orders")[0]

beforeEach(() => {
  vi.useFakeTimers()
  resetKit()
  h.afterFns = []
  h.verified.clear()
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  vi.mocked(chargeMobileMoney).mockClear()
  kit.db.app_settings = [{ key: null, paystack_fee_percentage: 3 }]
})

describe("Uzo AFA", () => {
  it("Paystack: price + fee, today's params, no Hubtel row", async () => {
    await handleAfaConfirm("1", "S1", session())
    expect(order().amount).toBeCloseTo(51.5, 2)
    await runAfter()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toEqual({
      email: "payer@example.com", amount: order().amount, phone: "+233244123456", provider: "mtn", reference: order().id,
      metadata: { source: "ussd_afa", ussd_afa_order_id: order().id, full_name: "Ama Mensah", gh_card_number: "GHA-123456789-0" },
    })
    expect(hubtelRows()).toHaveLength(0)
    expect(order().paystack_reference).toBe(order().id)
  })

  it("Paystack error still fails the order", async () => {
    h.charge = async () => { throw new Error("boom") }
    await handleAfaConfirm("1", "S1", session())
    await runAfter()
    expect(order()).toMatchObject({ payment_status: "failed", order_status: "failed" })
  })

  describe("on Hubtel", () => {
    beforeEach(() => { kit.config = gatewayConfig(["ussd"]) })

    it("accepted: no Paystack fee on the order, one prompt to the dialler", async () => {
      await handleAfaConfirm("1", "S1", session())
      expect(order().amount).toBe(50)
      await runAfter()
      expect(chargeMobileMoney).not.toHaveBeenCalled()
      expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", channel: "mtn-gh", amount: 50 })
      expect(hubtelRows()[0]).toMatchObject({ internal_reference: order().id, surface: "ussd" })
      expect(order()).toMatchObject({ payment_status: "pending", paystack_reference: order().id })
    })

    it("refused: Paystack at price + fee, the order moved first", async () => {
      kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
      let atCharge: number | undefined
      h.charge = async (p: any) => { atCharge = order().amount; return { status: "pay_offline", reference: p.reference } }
      await handleAfaConfirm("1", "S1", session())
      await runAfter()
      expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(51.5, 2)
      expect(atCharge).toBeCloseTo(51.5, 2)
    })

    it("unknown: the order isn't failed and Paystack isn't called", async () => {
      kit.receive.mockImplementation(async () => ({ kind: "unknown", code: "timeout", message: "slow" }))
      await handleAfaConfirm("1", "S1", session())
      await runAfter()
      expect(chargeMobileMoney).not.toHaveBeenCalled()
      expect(order().payment_status).toBe("pending")
    })

    it("a non-MTN dialler stays on Paystack (the prompt's provider is MTN)", async () => {
      await handleAfaConfirm("1", "S1", session({ dialingPhone: "+233201234567" }))
      expect(order().amount).toBeCloseTo(51.5, 2)
      await runAfter()
      expect(kit.receive).not.toHaveBeenCalled()
      expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    })

    it("WhatsApp: a number that isn't the sender's goes to Paystack", async () => {
      kit.config = gatewayConfig(["whatsapp"])
      await handleAfaConfirm("1", "233551234567", session({ dialingPhone: "0244123456" }), "whatsapp")
      await runAfter()
      expect(kit.receive).not.toHaveBeenCalled()
      expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(51.5, 2)
    })

    it("WhatsApp: the sender's own number goes to Hubtel on the whatsapp surface", async () => {
      kit.config = gatewayConfig(["whatsapp"])
      await handleAfaConfirm("1", "233244123456", session({ dialingPhone: "0244123456" }), "whatsapp")
      await runAfter()
      expect(hubtelRows()[0].surface).toBe("whatsapp")
    })

    it("WhatsApp: another number, even an OTP-verified one, goes to Paystack at price + fee", async () => {
      kit.config = gatewayConfig(["whatsapp"])
      h.verified.add("0244123456")
      await handleAfaConfirm("1", "233551234567", session({ dialingPhone: "0244123456" }), "whatsapp")
      expect(order().amount).toBeCloseTo(51.5, 2)
      await runAfter()
      expect(kit.receive).not.toHaveBeenCalled()
      expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBeCloseTo(51.5, 2)
    })
  })
})
