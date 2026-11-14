// Voucher confirm per channel. The ussd and whatsapp blocks are CHARACTERISATION tests, written against the code before
// the sms channel existed: they pin what the live bots do today. The sms block covers the text-to-buy channel.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void>>,
  charge: null as any,
  dialer: {} as any,
  enabled: true,
  avail: 10,
  max: 10,
  pricing: { unitPrice: 20, totalPaid: 40, bulkApplied: false } as any,
}))

vi.mock("@/lib/storefront-otp", async (orig) => ({ ...(await orig<object>()), isPhoneOtpVerified: vi.fn(async () => false) }))
vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
vi.mock("../session", () => ({ setSession: vi.fn(async () => {}) }))
vi.mock("../resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("../resolve-dialer", () => ({ resolveDialer: vi.fn(async () => ({ ...h.dialer })) }))
vi.mock("../wallet-balance", () => ({ liveWalletBalance: vi.fn(async () => undefined) }))
vi.mock("@/lib/paystack", async (orig) => ({ ...(await orig<object>()), chargeMobileMoney: vi.fn(async (p: any) => h.charge(p)) }))
vi.mock("../../sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: { ussdOtpRequired: () => "otp" } }))
vi.mock("../../whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn(async () => {}) }))
vi.mock("../../whatsapp-bot/session", () => ({ setWaSession: vi.fn(async () => {}) }))
vi.mock("../../secure-random", () => ({ secureReference: () => "RC-REF" }))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({})) }))
vi.mock("../../results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(async () => h.enabled), getAvailableCount: vi.fn(async () => h.avail), getMaxQuantity: vi.fn(async () => h.max),
  calculateRCPrice: vi.fn(async () => h.pricing),
  purchaseResultsCheckerVouchers: vi.fn(), getRCBulkHint: vi.fn(async () => null),
}))

import { confirmRcByText, handleRcConfirm } from "./results-checker"
import { chargeMobileMoney } from "@/lib/paystack"
import { sendSMS } from "../../sms-service"
import { sendWhatsAppText } from "../../whatsapp-bot/send"
import { setWaSession } from "../../whatsapp-bot/session"
import { setSession } from "../session"
import { resolveDialer } from "../resolve-dialer"
import { gatewayConfig, hubtelRows, kit, resetKit, rows } from "../gateway-test-kit"

const DIAL = "+233200000101"
const FUNDED = { userId: "u1", balance: 50, email: "dialer@example.com" }
const s = (over: Record<string, unknown> = {}): any => ({ step: "RC_CONFIRM", rcBoard: "WASSCE", rcQty: 2, rcTotal: 40, dialingPhone: DIAL, ...over })
const order = () => rows("results_checker_orders")[0]

async function launch(): Promise<{ done: Promise<unknown> }> {
  const fns = h.afterFns.splice(0)
  const done = Promise.all(fns.map((f) => f()))
  await vi.advanceTimersByTimeAsync(0)
  return { done }
}
/** Starts the captured after() callbacks and waits for them WITHOUT advancing timers: hangs if a wait remains. */
async function runNoWait() {
  const { done } = await launch()
  await done
}
async function runAfter() {
  const { done } = await launch()
  await vi.advanceTimersByTimeAsync(5000)
  await done
}

beforeEach(() => {
  vi.useFakeTimers()
  resetKit()
  kit.config = gatewayConfig()
  kit.config.surfaces.sms_order = { gateway: "paystack", mode: "direct", feeBearer: "customer" }
  h.afterFns = []
  h.dialer = {}
  h.enabled = true
  h.avail = 10
  h.max = 10
  h.pricing = { unitPrice: 20, totalPaid: 40, bulkApplied: false }
  h.charge = async (p: any) => ({ status: "pay_offline", reference: p.reference })
  for (const m of [chargeMobileMoney, sendSMS, sendWhatsAppText, setWaSession, setSession, resolveDialer]) vi.mocked(m as any).mockClear()
})

const EXPECTED_ROW = {
  reference_code: "RC-REF", exam_board: "WASSCE", quantity: 2, customer_name: "USSD Customer", customer_phone: "0200000101",
  unit_price: 20, fee_amount: 0, total_paid: 40, shop_id: null, merchant_commission: 0, status: "pending_payment",
  payment_status: "pending_payment", dialing_phone: DIAL, channel: "ussd",
}

describe.each(["ussd", "whatsapp"] as const)("characterisation: %s is unchanged", (channel) => {
  const sid = channel === "ussd" ? "S1" : "233200000101"

  it("not wallet-eligible: row, end message, two setSession writes, charge only after the 3 s wait", async () => {
    const r = await handleRcConfirm("1", sid, s(), channel)
    expect(r).toEqual({
      message: "MoMo prompt sent to 0200000101. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.",
      ussdServiceOp: 17,
    })
    expect(order()).toEqual({ id: expect.any(String), created_at: expect.any(String), ...EXPECTED_ROW, user_id: null, customer_email: null })
    expect(vi.mocked(setSession).mock.calls).toEqual([
      [sid, { ...s(), rcUnitPrice: 20, rcTotal: 40 }],
      [sid, { ...s(), pendingOrderId: order().id, pendingOrderTable: "results_checker_orders", step: "MAIN" }],
    ])
    const { done } = await launch()
    await vi.advanceTimersByTimeAsync(2999)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0]).toEqual({
      email: "payer@example.com", amount: 40, phone: DIAL, provider: "vod", reference: order().id,
      metadata: { source: "ussd_results_checker", results_checker_order_id: order().id, exam_board: "WASSCE", quantity: 2 },
    })
    expect(rows("payment_attempts")[0]).toMatchObject({ payment_type: "ussd_results_checker", amount: 40 })
    expect(hubtelRows()).toHaveLength(0)
  })

  it("funded registered dialer: RC_PAYMENT_METHOD menu, no order, no charge", async () => {
    h.dialer = FUNDED
    const r = await handleRcConfirm("1", sid, s(), channel)
    expect(r.message).toContain("GHS 50.00")
    expect(r.ussdServiceOp).toBe(2)
    expect(rows("results_checker_orders")).toHaveLength(0)
    expect(vi.mocked(setSession).mock.calls).toEqual([
      [sid, { ...s(), step: "RC_PAYMENT_METHOD", rcUnitPrice: 20, rcTotal: 40, userId: "u1", walletBalance: 50 }],
    ])
    expect(h.afterFns).toHaveLength(0)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
  })

  it("send_otp: otp_required and the channel's own follow-up", async () => {
    h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference })
    await handleRcConfirm("1", sid, s(), channel)
    await runAfter()
    expect(order().payment_status).toBe("otp_required")
    if (channel === "ussd") {
      expect(sendSMS).toHaveBeenCalledWith({ phone: DIAL, message: "otp", type: "otp_required", reference: order().id })
      expect(setWaSession).not.toHaveBeenCalled()
      expect(sendWhatsAppText).not.toHaveBeenCalled()
    } else {
      expect(setWaSession).toHaveBeenCalledWith(sid, {
        step: "SUBMIT_OTP", dialingPhone: DIAL, pendingOrderId: order().id, pendingOrderTable: "results_checker_orders",
      })
      expect(sendWhatsAppText).toHaveBeenCalledTimes(1)
      expect(sendSMS).not.toHaveBeenCalled()
    }
  })

  it("out of stock: no row, MAIN session, refusal text", async () => {
    h.avail = 1
    const r = await handleRcConfirm("1", sid, s(), channel)
    expect(r.message).toBe("WASSCE vouchers are no longer available in that quantity. Please try again.")
    expect(rows("results_checker_orders")).toHaveLength(0)
    expect(vi.mocked(setSession).mock.calls).toEqual([[sid, { step: "MAIN", dialingPhone: DIAL }]])
    expect(h.afterFns).toHaveLength(0)
  })
})

describe("sms channel (text-to-buy)", () => {
  const SENDER = "sms:m1"

  it("returns orderId and amount = the inserted total_paid", async () => {
    const r = await confirmRcByText(SENDER, s())
    expect(r.orderId).toBe(order().id)
    expect(r.amount).toBe(order().total_paid)
    expect(r.amount).toBe(40)
  })

  it("the amount is the RE-PRICED total, not the session's rcTotal: stored, returned and charged agree", async () => {
    h.pricing = { unitPrice: 22.5, totalPaid: 45, bulkApplied: false }
    const r = await confirmRcByText(SENDER, s({ rcTotal: 40 }))
    expect(order()).toMatchObject({ unit_price: 22.5, total_paid: 45 })
    expect(r.amount).toBe(45)
    await runNoWait()
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].amount).toBe(45)
    expect(rows("payment_attempts")[0]).toMatchObject({ amount: 45 })
  })

  it("row keeps channel ussd, the sender's local number as customer_phone, and the ussd source columns", async () => {
    await confirmRcByText(SENDER, s())
    await runNoWait()
    expect(order()).toMatchObject({ channel: "ussd", customer_phone: "0200000101", dialing_phone: DIAL, total_paid: 40, quantity: 2 })
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].metadata).toMatchObject({ source: "ussd_results_checker", results_checker_order_id: order().id })
    expect(rows("payment_attempts")[0]).toMatchObject({ payment_type: "ussd_results_checker" })
  })

  it("a funded registered sender gets no wallet step: order created, charge started", async () => {
    h.dialer = FUNDED
    const r = await confirmRcByText(SENDER, s())
    expect(r.orderId).toBe(order().id)
    expect(r.message).not.toContain("GHS 50.00")
    expect(h.afterFns).toHaveLength(1)
    await runNoWait()
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
  })

  it("charges on sms_order with no wait; the sender pays; setSession is never called", async () => {
    await confirmRcByText(SENDER, s())
    await runNoWait() // timers NOT advanced
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(vi.mocked(chargeMobileMoney).mock.calls[0][0].phone).toBe(DIAL)
    expect(setSession).not.toHaveBeenCalled()
    expect(hubtelRows()).toHaveLength(0)
  })

  it("send_otp: otp_required, no sendSMS, no sendWhatsAppText, no setWaSession, no setSession", async () => {
    h.charge = async (p: any) => ({ status: "send_otp", reference: p.reference })
    await confirmRcByText(SENDER, s())
    await runNoWait()
    expect(order().payment_status).toBe("otp_required")
    expect(sendSMS).not.toHaveBeenCalled()
    expect(sendWhatsAppText).not.toHaveBeenCalled()
    expect(setWaSession).not.toHaveBeenCalled()
    expect(setSession).not.toHaveBeenCalled()
  })

  it("charge throws: status and payment_status failed", async () => {
    h.charge = async () => { throw new Error("boom") }
    await confirmRcByText(SENDER, s())
    await runNoWait()
    expect(order()).toMatchObject({ status: "failed", payment_status: "failed" })
  })

  it("board disabled: no row, no orderId, no charge, no setSession", async () => {
    h.enabled = false
    const r = await confirmRcByText(SENDER, s())
    expect(r.orderId).toBeUndefined()
    expect(rows("results_checker_orders")).toHaveLength(0)
    expect(h.afterFns).toHaveLength(0)
    expect(setSession).not.toHaveBeenCalled()
  })

  it("stock below the quantity (one short): no row, no orderId", async () => {
    h.avail = 1
    const r = await confirmRcByText(SENDER, s({ rcQty: 2 }))
    expect(r.orderId).toBeUndefined()
    expect(rows("results_checker_orders")).toHaveLength(0)
    expect(h.afterFns).toHaveLength(0)
    expect(setSession).not.toHaveBeenCalled()
  })

  it("stock exactly the quantity is enough", async () => {
    h.avail = 2
    const r = await confirmRcByText(SENDER, s({ rcQty: 2 }))
    expect(r.orderId).toBe(order().id)
  })

  it("no MoMo provider for the sender: no row, no orderId", async () => {
    const r = await confirmRcByText(SENDER, s({ dialingPhone: "+233990000000" }))
    expect(r.orderId).toBeUndefined()
    expect(rows("results_checker_orders")).toHaveLength(0)
    expect(setSession).not.toHaveBeenCalled()
  })

  it("success message is exactly the MoMo prompt line", async () => {
    const r = await confirmRcByText(SENDER, s())
    expect(r.message).toBe("MoMo prompt sent to 0200000101. Approve to complete.")
  })

  describe.each([0, -1, 1.5, NaN, undefined, 11])("bad quantity %s", (qty) => {
    it("is refused: no row, no orderId, no charge, no setSession", async () => {
      const r = await confirmRcByText(SENDER, s({ rcQty: qty }))
      expect(r.orderId).toBeUndefined()
      expect(r.amount).toBeUndefined()
      expect(rows("results_checker_orders")).toHaveLength(0)
      expect(h.afterFns).toHaveLength(0)
      await runNoWait()
      expect(chargeMobileMoney).not.toHaveBeenCalled()
      expect(setSession).not.toHaveBeenCalled()
    })
  })

  it.each([1, 10])("quantity %s (1 and the max) still passes", async (qty) => {
    const r = await confirmRcByText(SENDER, s({ rcQty: qty }))
    expect(r.orderId).toBe(order().id)
  })

  it.each([0, -40, NaN, Infinity])("re-priced total %s is refused: no row, no orderId, no charge", async (totalPaid) => {
    h.pricing = { unitPrice: 20, totalPaid, bulkApplied: false }
    const r = await confirmRcByText(SENDER, s())
    expect(r.orderId).toBeUndefined()
    expect(rows("results_checker_orders")).toHaveLength(0)
    expect(h.afterFns).toHaveLength(0)
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(setSession).not.toHaveBeenCalled()
  })
  // An insert failure cannot be simulated: gateway-test-kit only fails hubtel_payments inserts and table updates.
})
