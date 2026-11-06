// End to end through the service with the real gateway registry: Hubtel-paid orders and the hubtel_send gateway.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sendMoney = vi.fn()
const checkSendStatus = vi.fn()
const describeSendStatus = vi.fn()
vi.mock("./hubtel-send-client", async (orig) => ({
  ...(await orig<typeof import("./hubtel-send-client")>()),
  sendMoney: (...a: unknown[]) => sendMoney(...a),
  checkSendStatus: (...a: unknown[]) => checkSendStatus(...a),
  describeSendStatus: (...a: unknown[]) => describeSendStatus(...a),
}))
vi.mock("@/lib/moolre-transfer", () => ({ initiateTransfer: vi.fn(), getTransferStatus: vi.fn() }))
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: vi.fn() }))
vi.mock("@/lib/paystack-transfer", () => ({
  createRecipient: vi.fn(), initiateTransfer: vi.fn(), finalizeTransfer: vi.fn(), getTransferStatus: vi.fn(),
  mapNetworkToPaystackBankCode: (n: string) => ({ MTN: "MTN", TELECEL: "VOD", AT: "ATL" } as Record<string, string>)[n.toUpperCase()],
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: vi.fn() }) }))

import { executeRefund, inspectHubtelSend, markHubtelSendNeverPaid, previewRefund, reconcileRefund, type RefundDeps, type StoredRefund } from "./service"
import { getGateway } from "./gateways"
import type { RefundableOrder } from "./types"

const RF = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

const hubtelOrder = (attempt: Record<string, unknown> = {}, o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "shop_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: "sA", shopName: "Alpha", packageLabel: "2GB", network: "MTN", recipientPhone: "0245550102",
  createdAt: "2026-11-05", paid: 10, gatewayFee: 0,
  payment: {
    gateway: "hubtel", reference: null, payerPhone: "0245550101", walletUserId: null, hubtelCollection: true,
    hubtelAttempt: { status: "paid", paidAttempts: 1, msisdn: "233245550101", channel: "mtn-gh", requestedPesewas: 1000, paymentMethod: "mobilemoney", ...attempt },
  },
  owners: [{ shopId: "sA", ownerUserId: "uA", credited: 3, pending: 0, availableBalance: 10, walletBalance: 0 }],
  evidence: { hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null },
  ...o,
})

function setup(ord: RefundableOrder | null, reserve?: (n: number) => { data?: any; error?: { message: string } | null }) {
  const calls: { name: string; args: any }[] = []
  let reserves = 0
  const deps: RefundDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === "reserve_order_refund") {
        reserves++
        const r = reserve?.(reserves)
        return r ? { data: r.data ?? null, error: r.error ?? null } : { data: { refund_id: RF, clawbacks: [] }, error: null }
      }
      return { data: name === "complete_order_refund" ? "completed" : name === "fail_order_refund" ? "failed" : null, error: null }
    },
    loadOrder: async () => ord,
    getGateway,
    notify: vi.fn(async () => {}),
  }
  return { deps, calls }
}
const names = (calls: { name: string }[]) => calls.map((c) => c.name)
const input = { table: "shop_orders" as const, orderId: "o1", gateway: "hubtel_send", amount: 10, adminId: "admin1" }

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("HUBTEL_SEND_REFUNDS_ENABLED", "true") })
afterEach(() => vi.unstubAllEnvs())

describe("previewRefund on a Hubtel-paid order", () => {
  it("a paid attempt is eligible and offers exactly the owner-approved gateways, hubtel_send first", async () => {
    const { deps } = setup(hubtelOrder())
    const p = await previewRefund(deps, { table: "shop_orders", id: "o1" })
    expect(p.eligibility.eligible).toBe(true)
    expect(p.gateways.filter((g) => g.ok).map((g) => g.id)).toEqual(["hubtel_send", "paystack_payout", "moolre", "manual"])
    expect(p.gateways[0].id).toBe("hubtel_send")
    const send = p.gateways.find((g) => g.id === "hubtel_send")
    expect(send).toMatchObject({ ok: true })
    expect(send?.maxAmount).toBeUndefined()
    const paystack = p.gateways.find((g) => g.id === "paystack")!
    expect(paystack.ok).toBe(false)
    expect(paystack.reason).toMatch(/Paystack/)
  })
  it.each(["pending", "confirming", "needs_review"])("a %s attempt is not eligible", async (status) => {
    const { deps } = setup(hubtelOrder({ status }))
    const p = await previewRefund(deps, { table: "shop_orders", id: "o1" })
    expect(p.eligibility).toMatchObject({ eligible: false, code: "HUBTEL_COLLECTION" })
  })
  it("with the switch off, hubtel_send says why and the other payouts still work", async () => {
    vi.stubEnv("HUBTEL_SEND_REFUNDS_ENABLED", "false")
    const { deps } = setup(hubtelOrder())
    const p = await previewRefund(deps, { table: "shop_orders", id: "o1" })
    expect(p.gateways.filter((g) => g.ok).map((g) => g.id)).toEqual(["paystack_payout", "moolre", "manual"])
  })
})

describe("executeRefund with hubtel_send", () => {
  it("reserves, sends once, parks the refund processing on an accepted send", async () => {
    sendMoney.mockResolvedValue({ kind: "pending", ref: "tx1" })
    const { deps, calls } = setup(hubtelOrder())
    const res = await executeRefund(deps, input)
    expect(res).toMatchObject({ refundId: RF, status: "processing" })
    expect(names(calls)).toEqual(["reserve_order_refund", "mark_refund_processing"])
    expect(calls[0].args).toMatchObject({ p_gateway: "hubtel_send", p_destination: "0245550101", p_amount: 10 })
    expect(sendMoney).toHaveBeenCalledTimes(1)
    expect(sendMoney.mock.calls[0][0]).toEqual({ refundId: RF, msisdn: "233245550101", channel: "mtn-gh", amount: 10 })
    expect(calls[1].args).toMatchObject({ p_gateway_ref: "tx1", p_status: "processing" })
  })
  it("a timeout after sending leaves the refund processing with the clawback in place, never failed", async () => {
    sendMoney.mockResolvedValue({ kind: "unknown", error: "Hubtel did not answer in time" })
    const { deps, calls } = setup(hubtelOrder())
    const res = await executeRefund(deps, input)
    expect(res.status).toBe("processing")
    expect(names(calls)).not.toContain("fail_order_refund")
  })
  it("a definite not-sent rejection compensates (failed)", async () => {
    sendMoney.mockResolvedValue({ kind: "failed", error: "insufficient balance" })
    const { deps, calls } = setup(hubtelOrder())
    expect((await executeRefund(deps, input)).status).toBe("failed")
    expect(names(calls)).toEqual(["reserve_order_refund", "fail_order_refund"])
  })
  it("two clicks give one send: the second reserve is refused and nothing is sent", async () => {
    sendMoney.mockResolvedValue({ kind: "pending", ref: "tx1" })
    const { deps } = setup(hubtelOrder(), (n) => (n === 1 ? { data: { refund_id: RF, clawbacks: [] } } : { error: { message: "ALREADY_REFUNDED" } }))
    await executeRefund(deps, input)
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "ALREADY_REFUNDED" })
    expect(sendMoney).toHaveBeenCalledTimes(1)
  })
  it("an amount above what the order paid is refused before any reserve or send", async () => {
    const { deps, calls } = setup(hubtelOrder())
    await expect(executeRefund(deps, { ...input, amount: 10.01 })).rejects.toMatchObject({ code: "BAD_AMOUNT" })
    expect(calls).toEqual([])
    expect(sendMoney).not.toHaveBeenCalled()
  })
  it("a partial amount within the cap is sent", async () => {
    sendMoney.mockResolvedValue({ kind: "pending", ref: "tx1" })
    const { deps } = setup(hubtelOrder({ requestedPesewas: 980 }))
    await executeRefund(deps, { ...input, amount: 9.8 })
    expect(sendMoney.mock.calls[0][0].amount).toBe(9.8)
  })
  it.each(["pending", "confirming", "needs_review"])("a %s attempt is refused before any reserve or send", async (status) => {
    const { deps, calls } = setup(hubtelOrder({ status }))
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
    expect(calls).toEqual([])
    expect(sendMoney).not.toHaveBeenCalled()
  })
  it("the switch off: hubtel_send is refused before any reserve, but moolre is still allowed for the paid attempt", async () => {
    vi.stubEnv("HUBTEL_SEND_REFUNDS_ENABLED", "false")
    const { deps, calls } = setup(hubtelOrder())
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "GATEWAY_UNSUPPORTED" })
    expect(calls).toEqual([])
    const other = await previewRefund(deps, { table: "shop_orders", id: "o1" })
    expect(other.gateways.find((g) => g.id === "moolre")?.ok).toBe(true)
  })
  it("Paystack reversal is refused on a Hubtel-paid order", async () => {
    const { deps, calls } = setup(hubtelOrder({}, { payment: { gateway: "paystack", reference: "stale-ref", payerPhone: "0245550101", walletUserId: null, hubtelCollection: true, hubtelAttempt: { status: "paid", paidAttempts: 1, msisdn: "233245550101", channel: "mtn-gh", requestedPesewas: 1000, paymentMethod: "mobilemoney" } } }))
    await expect(executeRefund(deps, { ...input, gateway: "paystack" })).rejects.toMatchObject({ code: "GATEWAY_UNSUPPORTED" })
    expect(calls).toEqual([])
  })
})

describe("reconcile a hubtel_send refund", () => {
  const NOW = Date.parse("2026-11-05T12:00:00Z")
  const row = (o: Partial<StoredRefund> = {}): StoredRefund => ({
    id: RF, order_table: "shop_orders", order_id: "o1", gateway: "hubtel_send", amount: 10, destination_phone: "0245550101",
    gateway_ref: "tx1", status: "processing", clawbacks: [],
    updated_at: new Date(NOW - 10 * 60_000).toISOString(), created_at: new Date(NOW - 20 * 60_000).toISOString(), ...o,
  })
  it("completed -> complete_order_refund, once", async () => {
    checkSendStatus.mockResolvedValue({ kind: "completed", ref: "tx9" })
    const { deps, calls } = setup(hubtelOrder())
    deps.now = () => NOW
    expect((await reconcileRefund(deps, row())).status).toBe("completed")
    expect(names(calls)).toEqual(["complete_order_refund"])
    expect(checkSendStatus).toHaveBeenCalledWith({ refundId: RF, amount: 10 })
  })
  it("failed -> fail_order_refund", async () => {
    checkSendStatus.mockResolvedValue({ kind: "failed", error: "Hubtel reports the payout failed" })
    const { deps, calls } = setup(hubtelOrder())
    deps.now = () => NOW
    expect((await reconcileRefund(deps, row())).status).toBe("failed")
    expect(names(calls)).toEqual(["fail_order_refund"])
  })
  it("no match yet -> still processing, nothing compensated", async () => {
    checkSendStatus.mockResolvedValue({ kind: "pending", ref: "ref" })
    const { deps, calls } = setup(hubtelOrder())
    deps.now = () => NOW
    expect((await reconcileRefund(deps, row())).status).toBe("processing")
    expect(names(calls)).toEqual(["mark_refund_processing"])
  })
})

describe("markHubtelSendNeverPaid (I1)", () => {
  const NOW = Date.parse("2026-11-06T12:00:00Z")
  const stuck = (o: Partial<StoredRefund> = {}): StoredRefund => ({
    id: RF, order_table: "shop_orders", order_id: "o1", gateway: "hubtel_send", amount: 10, destination_phone: "0245550101",
    gateway_ref: null, status: "processing", clawbacks: [], updated_at: "2026-11-06T11:50:00Z", created_at: "2026-11-06T09:00:00Z", ...o,
  })
  const withClock = (s: ReturnType<typeof setup>) => { s.deps.now = () => NOW; return s }

  it.each(["no_record", "failed"])("%s: re-checks first, then fails the row and restores the clawback", async (verdict) => {
    describeSendStatus.mockResolvedValue({ verdict, upstreamStatus: 400, raw: {} })
    const { deps, calls } = withClock(setup(hubtelOrder()))
    const out = await markHubtelSendNeverPaid(deps, stuck())
    expect(describeSendStatus).toHaveBeenCalledWith({ refundId: RF, amount: 10 })
    expect(out.status).toBe("failed")
    expect(names(calls)).toEqual(["fail_order_refund"])
  })
  // A retry is a new refund with a new ClientReference, so a wrong "no record" here can pay the customer twice.
  describe("no_record when Hubtel accepted the send", () => {
    const REFERENCE = RF.replace(/-/g, "").toLowerCase()
    beforeEach(() => { describeSendStatus.mockResolvedValue({ verdict: "no_record", upstreamStatus: 400, raw: {} }) })
    it("a stored Hubtel transaction id refuses, and changes nothing", async () => {
      const { deps, calls } = withClock(setup(hubtelOrder()))
      await expect(markHubtelSendNeverPaid(deps, stuck({ gateway_ref: "8a545e5c7357714b80b65f76" }))).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
      expect(calls).toEqual([])
    })
    it("our own reference is not an acceptance (reconcile stores it on a no-match)", async () => {
      const { deps, calls } = withClock(setup(hubtelOrder()))
      expect((await markHubtelSendNeverPaid(deps, stuck({ gateway_ref: REFERENCE }))).status).toBe("failed")
      expect(names(calls)).toEqual(["fail_order_refund"])
    })
    it("Hubtel's own failed verdict is still honoured with a transaction id", async () => {
      describeSendStatus.mockResolvedValue({ verdict: "failed", upstreamStatus: 200, raw: {} })
      const { deps } = withClock(setup(hubtelOrder()))
      expect((await markHubtelSendNeverPaid(deps, stuck({ gateway_ref: "8a545e5c7357714b80b65f76" }))).status).toBe("failed")
    })
    it("the status view doesn't offer the action on such a row", async () => {
      expect((await inspectHubtelSend(stuck({ gateway_ref: "8a545e5c7357714b80b65f76" }))).canMarkFailed).toBe(false)
      expect((await inspectHubtelSend(stuck())).canMarkFailed).toBe(true)
    })
  })

  it.each(["success", "no_answer", "unclear"])("%s: refuses and changes nothing", async (verdict) => {
    describeSendStatus.mockResolvedValue({ verdict, upstreamStatus: 200, raw: {} })
    const { deps, calls } = withClock(setup(hubtelOrder()))
    await expect(markHubtelSendNeverPaid(deps, stuck())).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
    expect(calls).toEqual([])
  })
  it("a throwing status check refuses", async () => {
    describeSendStatus.mockRejectedValue(new Error("x"))
    const { deps, calls } = withClock(setup(hubtelOrder()))
    await expect(markHubtelSendNeverPaid(deps, stuck())).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
    expect(calls).toEqual([])
  })
  it("too young to rule out: refused before Hubtel is asked", async () => {
    const { deps } = withClock(setup(hubtelOrder()))
    await expect(markHubtelSendNeverPaid(deps, stuck({ created_at: "2026-11-06T11:30:00Z" }))).rejects.toMatchObject({ code: "IN_FLIGHT" })
    await expect(markHubtelSendNeverPaid(deps, stuck({ created_at: undefined }))).rejects.toMatchObject({ code: "IN_FLIGHT" })
    expect(describeSendStatus).not.toHaveBeenCalled()
  })
  it("only an unsettled hubtel_send refund", async () => {
    const { deps } = withClock(setup(hubtelOrder()))
    await expect(markHubtelSendNeverPaid(deps, stuck({ gateway: "moolre" }))).rejects.toMatchObject({ code: "GATEWAY_UNSUPPORTED" })
    for (const status of ["completed", "failed", "awaiting_otp"]) {
      await expect(markHubtelSendNeverPaid(deps, stuck({ status }))).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" })
    }
  })
  it("the ledger already says completed: a conflict, not a quiet failure", async () => {
    describeSendStatus.mockResolvedValue({ verdict: "no_record", upstreamStatus: 400, raw: {} })
    const s = withClock(setup(hubtelOrder()))
    s.deps.rpc = async () => ({ data: "completed", error: null })
    await expect(markHubtelSendNeverPaid(s.deps, stuck())).rejects.toMatchObject({ code: "SETTLE_FAILED" })
  })
})

describe("the refund SMS goes out once (M3)", () => {
  const processing = (): StoredRefund => ({
    id: RF, order_table: "shop_orders", order_id: "o1", gateway: "hubtel_send", amount: 10, destination_phone: "0245550101",
    gateway_ref: null, status: "processing", clawbacks: [], updated_at: "2026-11-05T00:00:00Z", created_at: "2026-11-05T00:00:00Z",
  })
  const answering = (ledger: string) => {
    const s = setup(hubtelOrder())
    s.deps.rpc = async (name) => ({ data: name === "complete_order_refund" ? ledger : null, error: null })
    checkSendStatus.mockResolvedValue({ kind: "completed", ref: "TX1" })
    return s
  }
  it("the caller that moved the row notifies", async () => {
    const { deps } = answering("completed")
    expect((await reconcileRefund(deps, processing())).status).toBe("completed")
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })
  it("a caller that found it already completed reports completed and does not notify", async () => {
    const { deps } = answering("already_completed")
    expect((await reconcileRefund(deps, processing())).status).toBe("completed")
    expect(deps.notify).not.toHaveBeenCalled()
  })
  it("the ledger saying failed is still a conflict", async () => {
    const { deps } = answering("failed")
    await expect(reconcileRefund(deps, processing())).rejects.toMatchObject({ code: "SETTLE_FAILED" })
    expect(deps.notify).not.toHaveBeenCalled()
  })
})
