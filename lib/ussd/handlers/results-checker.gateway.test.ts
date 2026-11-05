// Uzo results checker (vouchers, results check, WhatsApp results check) with the REAL startMomoCharge. None of these
// adds a Paystack fee, so both gateways charge the same amount and a fallback re-prices nothing.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ afterFns: [] as Array<() => Promise<void>>, charge: null as any }))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
vi.mock("../session", () => ({ setSession: vi.fn(async () => {}) }))
vi.mock("../resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("../resolve-dialer", () => ({ resolveDialer: vi.fn(async () => ({})) }))
vi.mock("../wallet-balance", () => ({ liveWalletBalance: vi.fn(async () => undefined) }))
vi.mock("@/lib/paystack", async (orig) => ({ ...(await orig<object>()), chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)) }))
vi.mock("../../sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: { ussdOtpRequired: () => "otp" } }))
vi.mock("../../whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn(async () => {}) }))
vi.mock("../../secure-random", () => ({ secureReference: () => "RC-REF" }))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({})) }))
vi.mock("../../results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(async () => true), getAvailableCount: vi.fn(async () => 10), getMaxQuantity: vi.fn(async () => 10),
  calculateRCPrice: vi.fn(async () => ({ unitPrice: 20, totalPaid: 40, bulkApplied: false })),
  purchaseResultsCheckerVouchers: vi.fn(), getRCBulkHint: vi.fn(async () => null),
}))

import { handleRcConfirm, handleRcCheckPaymentMethod, handleRcCheckConfirmMomo } from "./results-checker"
import { chargeMobileMoney } from "@/lib/paystack"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "../gateway-test-kit"

const DIAL = "+233244123456"
async function runAfter() {
  const done = Promise.all(h.afterFns.splice(0).map((f) => f()))
  await vi.advanceTimersByTimeAsync(5000)
  await done
}
const rcSession = (over: any = {}): any => ({ step: "RC_CONFIRM", rcBoard: "WASSCE", rcQty: 2, rcTotal: 40, dialingPhone: DIAL, ...over })
const checkSession = (over: any = {}): any => ({
  step: "RC_CHECK_PAYMENT_METHOD", dialingPhone: DIAL, pendingOrderId: "req-1", rcCheckMode: "own_voucher", rcCheckFee: 2,
  rcCheckBoard: "WASSCE", rcCheckIndex: "123", rcCheckYear: "2024", ...over,
})

beforeEach(() => {
  vi.useFakeTimers()
  resetKit()
  h.afterFns = []
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  vi.mocked(chargeMobileMoney).mockClear()
  kit.db.results_check_requests = [{ id: "req-1", payment_status: "pending_payment", status: "pending" }]
})

describe("RC vouchers", () => {
  it("Paystack: today's params, no Hubtel row", async () => {
    await handleRcConfirm("1", "S1", rcSession())
    await runAfter()
    const o = rows("results_checker_orders")[0]
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toEqual({
      email: "payer@example.com", amount: 40, phone: DIAL, provider: "mtn", reference: o.id,
      metadata: { source: "ussd_results_checker", results_checker_order_id: o.id, exam_board: "WASSCE", quantity: 2 },
    })
    expect(hubtelRows()).toHaveLength(0)
  })

  it("Paystack error still fails the order", async () => {
    h.charge = async () => { throw new Error("boom") }
    await handleRcConfirm("1", "S1", rcSession())
    await runAfter()
    expect(rows("results_checker_orders")[0]).toMatchObject({ payment_status: "failed", status: "failed" })
  })

  describe("on Hubtel", () => {
    beforeEach(() => { kit.config = gatewayConfig(["ussd"]) })

    it("accepted: same amount, prompt to the dialler", async () => {
      await handleRcConfirm("1", "S1", rcSession())
      await runAfter()
      const o = rows("results_checker_orders")[0]
      expect(o.total_paid).toBe(40)
      expect(kit.receive.mock.calls[0][0]).toMatchObject({ msisdn: "233244123456", amount: 40 })
      expect(chargeMobileMoney).not.toHaveBeenCalled()
      expect(o.payment_status).toBe("pending_payment")
    })

    it("refused: Paystack at the same amount, nothing re-priced", async () => {
      kit.receive.mockImplementation(async () => ({ kind: "refused", code: "4000", message: "no" }))
      await handleRcConfirm("1", "S1", rcSession())
      await runAfter()
      expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBe(40)
      expect(kit.ops.filter(([t, op]) => t === "results_checker_orders" && op === "update")).toHaveLength(0)
    })

    it("unknown: not failed, no Paystack", async () => {
      kit.receive.mockImplementation(async () => ({ kind: "unknown", code: "timeout", message: "slow" }))
      await handleRcConfirm("1", "S1", rcSession())
      await runAfter()
      expect(chargeMobileMoney).not.toHaveBeenCalled()
      expect(rows("results_checker_orders")[0].payment_status).toBe("pending_payment")
    })
  })
})

describe("RC results check (USSD)", () => {
  it("Paystack unchanged", async () => {
    await handleRcCheckPaymentMethod("2", "S1", checkSession())
    await runAfter()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ amount: 2, phone: DIAL, provider: "mtn", reference: "req-1" })
  })

  it("Hubtel accepted; picking MoMo twice sends one prompt", async () => {
    kit.config = gatewayConfig(["ussd"])
    await handleRcCheckPaymentMethod("2", "S1", checkSession())
    await runAfter()
    await handleRcCheckPaymentMethod("2", "S1", checkSession())
    await runAfter()
    expect(kit.receive).toHaveBeenCalledTimes(1)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(kit.db.results_check_requests[0].payment_status).toBe("pending_payment")
  })
})

describe("WhatsApp results check", () => {
  beforeEach(() => { kit.config = gatewayConfig(["whatsapp"]) })

  it("the sender's own number goes to Hubtel on the whatsapp surface", async () => {
    await handleRcCheckConfirmMomo("233244123456", checkSession({ dialingPhone: "0244123456" }))
    await runAfter()
    expect(hubtelRows()[0].surface).toBe("whatsapp")
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("another typed number stays on Paystack", async () => {
    await handleRcCheckConfirmMomo("233244123456", checkSession({ dialingPhone: "0551234567" }))
    await runAfter()
    expect(kit.receive).not.toHaveBeenCalled()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toMatchObject({ phone: "0551234567", amount: 2 })
  })
})
