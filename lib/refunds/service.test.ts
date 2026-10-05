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
  evidence: { hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null },
  ...o,
})

const settleData = (name: string) => (name === "complete_order_refund" ? "completed" : name === "fail_order_refund" ? "failed" : null)

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
      return { data: settleData(name), error: null }
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
    const { deps, calls } = setup({ kind: "completed", ref: "x" }, order({ evidence: { hasActiveRefund: false, dispatchOutcome: "submitted", dispatchAttempts: 1, trackingStatuses: ["completed"], externalOrderId: null } }))
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

const NOW = Date.parse("2026-10-05T12:00:00Z")
const agoIso = (ms: number) => new Date(NOW - ms).toISOString()
const stored = (o: Partial<StoredRefund> = {}): StoredRefund => ({
  id: "rf1", order_table: "ussd_shop_orders", order_id: "o1", gateway: "paystack_payout",
  amount: 9.8, destination_phone: "0241112222", gateway_ref: "TRF_1", status: "awaiting_otp", clawbacks: [],
  updated_at: new Date(NOW - 60 * 60_000).toISOString(), ...o,
})

function otpSetup(over: Partial<RefundGateway>) {
  const calls: { name: string; args: any }[] = []
  const gateway: RefundGateway = {
    id: "paystack_payout", label: "Paystack payout", supports: () => ({ ok: true }),
    refund: vi.fn(), ...over,
  }
  const deps: RefundDeps = {
    rpc: async (name, args) => { calls.push({ name, args }); return { data: settleData(name), error: null } },
    loadOrder: async () => order(),
    getGateway: (id) => (id === "paystack_payout" ? gateway : undefined),
    notify: vi.fn(async () => {}),
    now: () => NOW,
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
    ["ORDER_NOT_FOUND", "NOT_FOUND"], ["BAD_AMOUNT", "BAD_AMOUNT"], ["BAD_TABLE", "BAD_AMOUNT"],
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

describe("fix round 1: settle conflicts and stranded rows", () => {
  const rpcWith = (s: ReturnType<typeof setup>, over: Record<string, any>) => {
    const base = s.deps.rpc
    s.deps.rpc = async (name, args) => {
      if (name in over) { s.calls.push({ name, args }); return over[name] }
      return base(name, args)
    }
    return s
  }

  it("completed + complete_order_refund error: parks the row (with ref) then throws SETTLE_FAILED carrying the ref", async () => {
    const s = rpcWith(setup({ kind: "completed", ref: "R9" }), { complete_order_refund: { data: null, error: { message: "db down" } } })
    await expect(executeRefund(s.deps, input)).rejects.toMatchObject({ code: "SETTLE_FAILED", detail: { outcome: "completed", ref: "R9" } })
    expect(names(s.calls)).toEqual(["reserve_order_refund", "complete_order_refund", "mark_refund_processing"])
    expect(s.calls[2].args).toMatchObject({ p_refund_id: "rf1", p_gateway_ref: "R9", p_status: "processing" })
    expect(s.deps.notify).not.toHaveBeenCalled()
  })

  it("park failure is swallowed; SETTLE_FAILED still thrown", async () => {
    const s = rpcWith(setup({ kind: "completed", ref: "R9" }), {
      complete_order_refund: { data: null, error: { message: "db down" } },
      mark_refund_processing: { data: null, error: { message: "still down" } },
    })
    await expect(executeRefund(s.deps, input)).rejects.toMatchObject({ code: "SETTLE_FAILED" })
  })

  it("an rpc that throws after a completed payout is parked and surfaced as SETTLE_FAILED", async () => {
    const s = setup({ kind: "completed", ref: "R9" })
    const base = s.deps.rpc
    s.deps.rpc = async (name, args) => {
      if (name === "complete_order_refund") throw new Error("network")
      return base(name, args)
    }
    await expect(executeRefund(s.deps, input)).rejects.toMatchObject({ code: "SETTLE_FAILED" })
    expect(names(s.calls)).toContain("mark_refund_processing")
  })

  it("complete on a failed ledger row is a conflict: SETTLE_FAILED, no customer SMS", async () => {
    const s = rpcWith(setup({ kind: "completed", ref: "R9" }), { complete_order_refund: { data: "failed", error: null } })
    await expect(executeRefund(s.deps, input)).rejects.toMatchObject({
      code: "SETTLE_FAILED", detail: { conflict: true, ledgerStatus: "failed", outcome: "completed", ref: "R9" },
    })
    expect(s.deps.notify).not.toHaveBeenCalled()
  })

  it("fail_order_refund returning completed is a conflict", async () => {
    const s = rpcWith(setup({ kind: "failed", error: "declined" }), { fail_order_refund: { data: "completed", error: null } })
    await expect(executeRefund(s.deps, input)).rejects.toMatchObject({ code: "SETTLE_FAILED", detail: { conflict: true, ledgerStatus: "completed" } })
  })

  it("cancel: fail_order_refund returning completed is a conflict", async () => {
    const { deps } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "otp", ref: "T" } as GatewayOutcome)) })
    deps.rpc = async () => ({ data: "completed", error: null })
    await expect(cancelRefund(deps, stored())).rejects.toMatchObject({ code: "SETTLE_FAILED", detail: { conflict: true, ledgerStatus: "completed" } })
  })

  it("submitRefundOtp: complete conflict throws and sends no SMS", async () => {
    const { deps } = otpSetup({ finalizeOtp: vi.fn(async () => ({ kind: "completed", ref: "T" } as GatewayOutcome)) })
    deps.rpc = async () => ({ data: "failed", error: null })
    await expect(submitRefundOtp(deps, stored(), "123456")).rejects.toMatchObject({ code: "SETTLE_FAILED", detail: { conflict: true } })
    expect(deps.notify).not.toHaveBeenCalled()
  })
})

describe("rpc argument contracts", () => {
  it("reserve args", async () => {
    const { deps, calls } = setup({ kind: "completed", ref: "R1" })
    await executeRefund(deps, input)
    expect(calls[0].args).toEqual({
      p_order_table: "ussd_shop_orders", p_order_id: "o1", p_gateway: "paystack", p_paid: 10, p_fee: 0.2,
      p_amount: 9.8, p_destination: "0241112222", p_wallet_user: null, p_admin: "admin1", p_expected_attempts: 0,
    })
    expect(calls[1]).toMatchObject({ name: "complete_order_refund", args: { p_refund_id: "rf1", p_gateway_ref: "R1" } })
  })
  it("fail args", async () => {
    const { deps, calls } = setup({ kind: "failed", error: "declined" })
    await executeRefund(deps, input)
    expect(calls[1].args).toEqual({ p_refund_id: "rf1", p_error: "declined" })
  })
  it("unknown path args", async () => {
    const { deps, calls } = setup({ kind: "unknown", error: "timeout" })
    await executeRefund(deps, input)
    expect(calls[1].args).toMatchObject({ p_refund_id: "rf1", p_gateway_ref: null, p_status: "processing" })
  })
  it("notify payload passes clawbacks through", async () => {
    const cb = [{ shop_id: "sA", owner_user_id: "uA", from_profit: 3, from_wallet: 0, credited: 3 }]
    const { deps } = setup({ kind: "completed", ref: "R1" }, order(), { data: { refund_id: "rf1", clawbacks: cb } })
    await executeRefund(deps, input)
    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ refundId: "rf1", amount: 9.8, gateway: "paystack", clawbacks: cb }))
  })
  it("awaits notify and swallows its failure", async () => {
    const { deps } = setup({ kind: "completed", ref: "R1" })
    let done = false
    ;(deps.notify as any).mockImplementation(async () => { await new Promise((r) => setTimeout(r, 5)); done = true; throw new Error("x") })
    await executeRefund(deps, input)
    expect(done).toBe(true)
  })
  it("unsupported gateway (supports ok:false) -> GATEWAY_UNSUPPORTED before reserve", async () => {
    const { deps, calls, gateway } = setup({ kind: "completed", ref: "x" })
    gateway.supports = () => ({ ok: false, reason: "no phone" })
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "GATEWAY_UNSUPPORTED", message: "no phone" })
    expect(calls).toEqual([])
  })
})

describe("reconcile / otp extras", () => {
  it.each(["completed", "failed"])("rejects a %s row", async (status) => {
    const { deps } = otpSetup({ checkStatus: vi.fn() })
    await expect(reconcileRefund(deps, stored({ status }))).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" })
  })
  it("accepts a reserved row", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "completed", ref: "T" } as GatewayOutcome)) })
    expect((await reconcileRefund(deps, stored({ status: "reserved" }))).status).toBe("completed")
    expect(calls[0].name).toBe("complete_order_refund")
  })
  it("gateway without checkStatus returns the stored status", async () => {
    const { deps, calls } = otpSetup({})
    expect((await reconcileRefund(deps, stored({ status: "reserved" }))).status).toBe("reserved")
    expect((await reconcileRefund(deps, stored({ status: "awaiting_otp" }))).status).toBe("awaiting_otp")
    expect(calls).toEqual([])
  })
  it("failed outcome compensates", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "failed", error: "nope" } as GatewayOutcome)) })
    expect((await reconcileRefund(deps, stored({ status: "processing" }))).status).toBe("failed")
    expect(calls[0]).toMatchObject({ name: "fail_order_refund", args: { p_error: "nope" } })
  })
  it("unknown outcome never compensates", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "unknown", error: "t" } as GatewayOutcome)) })
    await reconcileRefund(deps, stored({ status: "processing" }))
    expect(calls.map((c) => c.name)).not.toContain("fail_order_refund")
  })
  it("finalizeOtp throwing => processing, never fail_order_refund", async () => {
    const { deps, calls } = otpSetup({ finalizeOtp: vi.fn(async () => { throw new Error("boom") }) })
    expect((await submitRefundOtp(deps, stored(), "123456")).status).toBe("processing")
    expect(calls.map((c) => c.name)).toEqual(["mark_refund_processing"])
  })
})

describe("p_expected_attempts (dispatch finished between read and reserve)", () => {
  it("passes the loaded claim count", async () => {
    const { deps, calls } = setup({ kind: "completed", ref: "R1" }, order({ evidence: { hasActiveRefund: false, dispatchOutcome: "failed", dispatchAttempts: 3, trackingStatuses: [], externalOrderId: null } }))
    await executeRefund(deps, input)
    expect(calls[0].args.p_expected_attempts).toBe(3)
  })
  it("expects 0 when there was no claims row", async () => {
    const { deps, calls } = setup({ kind: "completed", ref: "R1" })
    await executeRefund(deps, input)
    expect(calls[0].args.p_expected_attempts).toBe(0)
  })
  it("a DISPATCH_ACTIVE from the reserve maps to DISPATCH_ACTIVE and the gateway is never called", async () => {
    const { deps, gateway } = setup({ kind: "completed", ref: "x" }, order(), { error: { message: "DISPATCH_ACTIVE" } })
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "DISPATCH_ACTIVE" })
    expect(gateway.refund).not.toHaveBeenCalled()
  })
})

describe("in-flight protection (I-1)", () => {
  it.each(["reserved", "processing"])("reconcile refuses a %s row updated 1 minute ago", async (status) => {
    const checkStatus = vi.fn(async () => ({ kind: "failed", error: "x" } as GatewayOutcome))
    const { deps, calls } = otpSetup({ checkStatus })
    await expect(reconcileRefund(deps, stored({ status, updated_at: agoIso(60_000) }))).rejects.toMatchObject({ code: "IN_FLIGHT" })
    expect(checkStatus).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it("reconcile proceeds on a processing row older than 5 minutes", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "completed", ref: "T" } as GatewayOutcome)) })
    expect((await reconcileRefund(deps, stored({ status: "processing", updated_at: agoIso(5 * 60_000 + 1) }))).status).toBe("completed")
    expect(calls[0].name).toBe("complete_order_refund")
  })
  it("reconcile of a fresh awaiting_otp row is not age-gated", async () => {
    const { deps } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "otp", ref: "TRF_1" } as GatewayOutcome)) })
    await expect(reconcileRefund(deps, stored({ updated_at: agoIso(1000) }))).resolves.toBeDefined()
  })
  it("cancel refuses an awaiting_otp row younger than 60 seconds", async () => {
    const checkStatus = vi.fn()
    const { deps, calls } = otpSetup({ checkStatus })
    await expect(cancelRefund(deps, stored({ updated_at: agoIso(30_000) }))).rejects.toMatchObject({ code: "IN_FLIGHT" })
    expect(checkStatus).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it("cancel proceeds once the awaiting_otp row is 60s old", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "otp", ref: "TRF_1" } as GatewayOutcome)) })
    expect((await cancelRefund(deps, stored({ updated_at: agoIso(60_000) }))).status).toBe("failed")
    expect(calls[0].name).toBe("fail_order_refund")
  })
  it("OTP submit is not age-gated", async () => {
    const { deps } = otpSetup({ finalizeOtp: vi.fn(async () => ({ kind: "completed", ref: "TRF_1" } as GatewayOutcome)) })
    expect((await submitRefundOtp(deps, stored({ updated_at: agoIso(1000) }), "123456")).status).toBe("completed")
  })
  it("a missing updated_at on a processing row is treated as in flight", async () => {
    const { deps } = otpSetup({ checkStatus: vi.fn() })
    await expect(reconcileRefund(deps, stored({ status: "processing", updated_at: undefined as any }))).rejects.toMatchObject({ code: "IN_FLIGHT" })
  })
})
