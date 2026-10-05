import {
  executeRefund, previewRefund, submitRefundOtp, cancelRefund, reconcileRefund,
  RefundError, mapReserveError, type RefundDeps, type StoredRefund,
} from "./service"
import type { RefundableOrder, RefundGateway, GatewayOutcome } from "./types"

const order = (o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "ussd_shop_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: "sA", shopName: "Alpha", packageLabel: "2", network: "MTN", recipientPhone: "0243334444",
  createdAt: "2026-10-05", paid: 10, gatewayFee: 0.2,
  payment: { gateway: "paystack", reference: "o1", payerPhone: "0241112222", walletUserId: null },
  owners: [{ shopId: "sA", ownerUserId: "uA", credited: 3, pending: 0, availableBalance: 10, walletBalance: 0 }],
  evidence: { hasActiveRefund: false, dispatchOutcome: null, trackingStatuses: [], externalOrderId: null },
  ...o,
})

function setup(outcome: GatewayOutcome, ord: RefundableOrder | null = order(), reserve?: { data?: any; error?: { message: string } | null }) {
  const calls: { name: string; args: any }[] = []
  const gateway: RefundGateway = {
    id: "paystack", label: "Paystack", supports: () => ({ ok: true }),
    refund: vi.fn(async () => outcome),
  }
  const deps: RefundDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === "reserve_order_refund") return reserve ? { data: reserve.data ?? null, error: reserve.error ?? null } : { data: { refund_id: "rf1", clawbacks: [] }, error: null }
      return { data: null, error: null }
    },
    loadOrder: async () => ord,
    getGateway: (id) => (id === "paystack" ? gateway : undefined),
    notify: vi.fn(async () => {}),
  }
  return { deps, calls, gateway }
}
const input = { table: "ussd_shop_orders" as const, orderId: "o1", gateway: "paystack", amount: 9.8, adminId: "admin1" }
const names = (calls: { name: string }[]) => calls.map((c) => c.name)

describe("executeRefund", () => {
  it("reserves, pays out, then completes", async () => {
    const { deps, calls, gateway } = setup({ kind: "completed", ref: "R1" })
    const res = await executeRefund(deps, input)
    expect(res).toMatchObject({ refundId: "rf1", status: "completed" })
    expect(names(calls)).toEqual(["reserve_order_refund", "complete_order_refund"])
    expect(calls[0].args).toMatchObject({ p_order_table: "ussd_shop_orders", p_order_id: "o1", p_gateway: "paystack", p_paid: 10, p_amount: 9.8, p_destination: "0241112222", p_admin: "admin1" })
    expect(gateway.refund).toHaveBeenCalledTimes(1)
    expect(deps.notify).toHaveBeenCalled()
  })

  it("compensates (fail_order_refund) on a definitive gateway failure", async () => {
    const { deps, calls } = setup({ kind: "failed", error: "declined" })
    const res = await executeRefund(deps, input)
    expect(res).toMatchObject({ status: "failed", message: "declined" })
    expect(names(calls)).toEqual(["reserve_order_refund", "fail_order_refund"])
  })

  it("does NOT compensate on an ambiguous result — stays processing", async () => {
    const { deps, calls } = setup({ kind: "unknown", error: "timeout" })
    const res = await executeRefund(deps, input)
    expect(res.status).toBe("processing")
    expect(names(calls)).toEqual(["reserve_order_refund", "mark_refund_processing"])
    expect(names(calls)).not.toContain("fail_order_refund")
  })

  it("keeps an accepted-but-async payout (pending) in processing", async () => {
    const { deps, calls } = setup({ kind: "pending", ref: "T2" })
    expect((await executeRefund(deps, input)).status).toBe("processing")
    expect(calls[1]).toMatchObject({ name: "mark_refund_processing", args: { p_gateway_ref: "T2" } })
  })

  it("parks an OTP-gated payout in awaiting_otp, keeping the transfer code and the clawback", async () => {
    const { deps, calls } = setup({ kind: "otp", ref: "TRF_1" })
    const res = await executeRefund(deps, input)
    expect(res.status).toBe("awaiting_otp")
    expect(calls[1]).toMatchObject({ name: "mark_refund_processing", args: { p_refund_id: "rf1", p_gateway_ref: "TRF_1", p_status: "awaiting_otp" } })
    expect(names(calls)).not.toContain("fail_order_refund")
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it("treats a thrown adapter error as unknown, not failed", async () => {
    const { deps, calls, gateway } = setup({ kind: "completed", ref: "x" })
    ;(gateway.refund as any).mockRejectedValue(new Error("boom"))
    expect((await executeRefund(deps, input)).status).toBe("processing")
    expect(names(calls)).not.toContain("fail_order_refund")
  })

  it("never calls the gateway when the reserve fails (shortfall)", async () => {
    const { deps, gateway } = setup({ kind: "completed", ref: "x" }, order(), { error: { message: "SHORTFALL:sA:3.00" } })
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "SHORTFALL" })
    expect(gateway.refund).not.toHaveBeenCalled()
  })

  it("rejects ineligible orders before touching the database", async () => {
    const { deps, calls } = setup({ kind: "completed", ref: "x" }, order({ evidence: { hasActiveRefund: false, dispatchOutcome: "submitted", trackingStatuses: ["completed"], externalOrderId: null } }))
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
    expect(calls).toEqual([])
  })

  it.each([0, -1, NaN, 10.01])("rejects bad amount %s", async (amount) => {
    const { deps, calls } = setup({ kind: "completed", ref: "x" })
    await expect(executeRefund(deps, { ...input, amount })).rejects.toMatchObject({ code: "BAD_AMOUNT" })
    expect(calls).toEqual([])
  })

  it("rejects an unsupported or unknown gateway", async () => {
    const { deps } = setup({ kind: "completed", ref: "x" })
    await expect(executeRefund(deps, { ...input, gateway: "nope" })).rejects.toMatchObject({ code: "GATEWAY_UNSUPPORTED" })
  })

  it("maps a missing order to NOT_FOUND", async () => {
    const { deps } = setup({ kind: "completed", ref: "x" }, null)
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a notify failure never fails a completed refund", async () => {
    const { deps } = setup({ kind: "completed", ref: "R1" })
    ;(deps.notify as any).mockRejectedValue(new Error("sms down"))
    expect((await executeRefund(deps, input)).status).toBe("completed")
  })
})

const stored = (o: Partial<StoredRefund> = {}): StoredRefund => ({
  id: "rf1", order_table: "ussd_shop_orders", order_id: "o1", gateway: "paystack_payout",
  amount: 9.8, destination_phone: "0241112222", gateway_ref: "TRF_1", status: "awaiting_otp", clawbacks: [], ...o,
})

function otpSetup(over: Partial<RefundGateway>) {
  const calls: { name: string; args: any }[] = []
  const gateway: RefundGateway = {
    id: "paystack_payout", label: "Paystack payout", supports: () => ({ ok: true }),
    refund: vi.fn(), ...over,
  }
  const deps: RefundDeps = {
    rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null } },
    loadOrder: async () => order(),
    getGateway: (id) => (id === "paystack_payout" ? gateway : undefined),
    notify: vi.fn(async () => {}),
  }
  return { deps, calls }
}

describe("submitRefundOtp", () => {
  it("completes the refund when Paystack accepts the code", async () => {
    const { deps, calls } = otpSetup({ finalizeOtp: vi.fn(async () => ({ kind: "completed", ref: "TRF_1" } as GatewayOutcome)) })
    const res = await submitRefundOtp(deps, stored(), "123456")
    expect(res.status).toBe("completed")
    expect(calls.map((c) => c.name)).toEqual(["complete_order_refund"])
    expect(deps.notify).toHaveBeenCalled()
  })

  it("keeps awaiting_otp and writes nothing when the code is wrong", async () => {
    const { deps, calls } = otpSetup({ finalizeOtp: vi.fn(async () => ({ kind: "otp", ref: "TRF_1" } as GatewayOutcome)) })
    const res = await submitRefundOtp(deps, stored(), "000000")
    expect(res.status).toBe("awaiting_otp")
    expect(res.message).toMatch(/try again/i)
    expect(calls).toEqual([])
  })

  it("moves to processing when Paystack reports the transfer pending", async () => {
    const { deps, calls } = otpSetup({ finalizeOtp: vi.fn(async () => ({ kind: "pending", ref: "TRF_1" } as GatewayOutcome)) })
    expect((await submitRefundOtp(deps, stored(), "123456")).status).toBe("processing")
    expect(calls[0].name).toBe("mark_refund_processing")
  })

  it.each(["", " ", "12", "abcdef", "1234567890123"])("rejects a malformed otp %j before calling the gateway", async (otp) => {
    const finalizeOtp = vi.fn()
    const { deps } = otpSetup({ finalizeOtp })
    await expect(submitRefundOtp(deps, stored(), otp)).rejects.toMatchObject({ code: "BAD_OTP" })
    expect(finalizeOtp).not.toHaveBeenCalled()
  })

  it("only works on awaiting_otp refunds that have a transfer code", async () => {
    const { deps } = otpSetup({ finalizeOtp: vi.fn() })
    await expect(submitRefundOtp(deps, stored({ status: "processing" }), "123456")).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" })
    await expect(submitRefundOtp(deps, stored({ gateway_ref: null }), "123456")).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" })
  })
})

describe("cancelRefund", () => {
  it("restores the clawback when the transfer is still waiting for its OTP", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "otp", ref: "TRF_1" } as GatewayOutcome)) })
    const res = await cancelRefund(deps, stored())
    expect(res.status).toBe("failed")
    expect(calls.map((c) => c.name)).toEqual(["fail_order_refund"])
  })

  it("refuses to cancel (and settles instead) if the transfer actually went through", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "completed", ref: "TRF_1" } as GatewayOutcome)) })
    const res = await cancelRefund(deps, stored())
    expect(res.status).toBe("completed")
    expect(calls.map((c) => c.name)).toEqual(["complete_order_refund"])
  })

  it("refuses to cancel when the status cannot be confirmed", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "unknown", error: "timeout" } as GatewayOutcome)) })
    const res = await cancelRefund(deps, stored())
    expect(res.status).toBe("awaiting_otp")
    expect(calls.map((c) => c.name)).not.toContain("fail_order_refund")
  })

  it("only works on awaiting_otp refunds", async () => {
    const { deps } = otpSetup({ checkStatus: vi.fn() })
    await expect(cancelRefund(deps, stored({ status: "completed" }))).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" })
  })
})

describe("reconcileRefund", () => {
  it("settles an awaiting_otp refund whose transfer later succeeded", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "completed", ref: "TRF_1" } as GatewayOutcome)) })
    expect((await reconcileRefund(deps, stored())).status).toBe("completed")
    expect(calls[0].name).toBe("complete_order_refund")
  })
})

describe("mapReserveError", () => {
  it.each([
    ["ALREADY_REFUNDED", "ALREADY_REFUNDED"], ["ORDER_NOT_PENDING", "ORDER_NOT_PENDING"],
    ["DISPATCH_ACTIVE", "DISPATCH_ACTIVE"], ["SHORTFALL:abc:3.5", "SHORTFALL"], ["weird", "RESERVE_FAILED"],
  ])("%s → %s", (msg, code) => expect(mapReserveError(msg).code).toBe(code))
  it("keeps shortfall detail", () => {
    expect(mapReserveError("SHORTFALL:shop-1:3.5").detail).toEqual({ shopId: "shop-1", amount: 3.5 })
  })
})

describe("previewRefund", () => {
  it("returns eligibility, default amount, gateway support and the clawback plan", async () => {
    const { deps } = setup({ kind: "completed", ref: "x" })
    const p = await previewRefund(deps, { table: "ussd_shop_orders", id: "o1" })
    expect(p.eligibility.eligible).toBe(true)
    expect(p.defaultAmount).toBe(9.8)
    expect(p.clawback.ok).toBe(true)
    expect(p.gateways.find((g) => g.id === "paystack")).toMatchObject({ ok: true })
  })
})

describe("preview with ineligible order", () => {
  it("does not throw; returns eligibility", async () => {
    const { deps } = setup({ kind: "completed", ref: "x" }, order({ orderStatus: "completed" }))
    const p = await previewRefund(deps, { table: "ussd_shop_orders", id: "o1" })
    expect(p.eligibility.eligible).toBe(false)
  })
})

describe("SETTLE_FAILED / malformed reserve", () => {
  function failingRpc(failName: string, outcome: GatewayOutcome) {
    const s = setup(outcome)
    const base = s.deps.rpc
    s.deps.rpc = async (name, args) => (name === failName ? { data: null, error: { message: "db down" } } : base(name, args))
    return s
  }
  it("gateway completed but complete_order_refund errors", async () => {
    const { deps } = failingRpc("complete_order_refund", { kind: "completed", ref: "R1" })
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "SETTLE_FAILED", detail: { outcome: "completed" } })
    expect(deps.notify).not.toHaveBeenCalled()
  })
  it("mark_refund_processing errors", async () => {
    const { deps } = failingRpc("mark_refund_processing", { kind: "pending", ref: "T" })
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "SETTLE_FAILED", detail: { outcome: "pending" } })
  })
  it("fail_order_refund errors", async () => {
    const { deps } = failingRpc("fail_order_refund", { kind: "failed", error: "declined" })
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "SETTLE_FAILED", detail: { outcome: "failed" } })
  })
  it("reconcile surfaces settle rpc errors", async () => {
    const { deps } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "completed", ref: "T" } as GatewayOutcome)) })
    deps.rpc = async () => ({ data: null, error: { message: "db down" } })
    await expect(reconcileRefund(deps, stored())).rejects.toMatchObject({ code: "SETTLE_FAILED" })
  })
  it("cancel surfaces fail_order_refund errors", async () => {
    const { deps } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "otp", ref: "T" } as GatewayOutcome)) })
    deps.rpc = async () => ({ data: null, error: { message: "db down" } })
    await expect(cancelRefund(deps, stored())).rejects.toMatchObject({ code: "SETTLE_FAILED" })
  })
  it("malformed reserve data -> RESERVE_FAILED, gateway untouched", async () => {
    const { deps, gateway } = setup({ kind: "completed", ref: "x" }, order(), { data: null })
    deps.rpc = async () => ({ data: null, error: null })
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "RESERVE_FAILED" })
    expect(gateway.refund).not.toHaveBeenCalled()
  })
})
