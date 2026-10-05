import type { RefundableOrder, RefundContext } from "../types"

const refundTransaction = vi.fn()
const fetchRefund = vi.fn()
const moolreTransfer = vi.fn()
const moolreStatus = vi.fn()
const rpc = vi.fn()

vi.mock("@/lib/paystack", () => ({
  refundTransaction: (...a: unknown[]) => refundTransaction(...a),
  fetchRefund: (...a: unknown[]) => fetchRefund(...a),
}))
vi.mock("@/lib/moolre-transfer", () => ({
  initiateTransfer: (...a: unknown[]) => moolreTransfer(...a),
  getTransferStatus: (...a: unknown[]) => moolreStatus(...a),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }))

const createRecipient = vi.fn()
const psTransfer = vi.fn()
const psFinalize = vi.fn()
const psStatus = vi.fn()
vi.mock("@/lib/paystack-transfer", () => ({
  createRecipient: (...a: unknown[]) => createRecipient(...a),
  initiateTransfer: (...a: unknown[]) => psTransfer(...a),
  finalizeTransfer: (...a: unknown[]) => psFinalize(...a),
  getTransferStatus: (...a: unknown[]) => psStatus(...a),
  mapNetworkToPaystackBankCode: (n: string) => ({ MTN: "MTN", TELECEL: "VOD", AT: "ATL" } as Record<string, string>)[n.toUpperCase()],
}))

import { paystackGateway, mapPaystackRefundStatus, describePaystackRefund } from "./paystack"
import { paystackPayoutGateway } from "./paystack-payout"
import { moolreGateway, momoNetworkForMoolre } from "./moolre"
import { walletGateway } from "./wallet"
import { getGateway, listGateways } from "./index"

const order = (o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "ussd_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: null, shopName: null, packageLabel: "2", network: "MTN", recipientPhone: "0241112222",
  createdAt: "2026-10-05", paid: 10, gatewayFee: 0,
  payment: { gateway: "paystack", reference: "ref-1", payerPhone: "0241112222", walletUserId: null },
  owners: [], evidence: { hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null },
  ...o,
})
const ctx = (o: Partial<RefundableOrder> = {}, amount = 9.5): RefundContext => ({
  refundId: "rf-1", order: order(o), amount, destinationPhone: "0241112222",
})

beforeEach(() => vi.clearAllMocks())

describe("registry", () => {
  it("lists every adapter and resolves by id", () => {
    expect(listGateways().map((g) => g.id).sort()).toEqual(["moolre", "paystack", "paystack_payout", "wallet"])
    expect(getGateway("moolre")).toBe(moolreGateway)
    expect(getGateway("nope")).toBeUndefined()
  })
})

describe("paystackGateway", () => {
  it("is only supported for orders paid via Paystack with a reference", () => {
    expect(paystackGateway.supports(order()).ok).toBe(true)
    expect(paystackGateway.supports(order({ payment: { gateway: "wallet", reference: null, payerPhone: null, walletUserId: "u" } })).ok).toBe(false)
    expect(paystackGateway.supports(order({ payment: { gateway: null, reference: null, payerPhone: null, walletUserId: null } })).ok).toBe(false)
  })
  it("refunds the original reference with the chosen amount", async () => {
    refundTransaction.mockResolvedValue({ id: 99, status: "pending" })
    const out = await paystackGateway.refund(ctx())
    expect(refundTransaction).toHaveBeenCalledWith("ref-1", 9.5)
    expect(out).toEqual({ kind: "pending", ref: "99" })
  })
  it.each([
    ["pending", { kind: "pending", ref: "99" }],
    ["processing", { kind: "pending", ref: "99" }],
    ["needs-attention", { kind: "pending", ref: "99" }],
    ["processed", { kind: "completed", ref: "99" }],
    ["failed", { kind: "failed", error: "Paystack could not process the refund" }],
  ])("refund() with initial status %s", async (status, expected) => {
    refundTransaction.mockResolvedValue({ id: 99, status })
    expect(await paystackGateway.refund(ctx())).toEqual(expected)
  })
  it("refund() with an unknown/missing status is unknown", async () => {
    refundTransaction.mockResolvedValue({ id: 99, status: "weird" })
    expect((await paystackGateway.refund(ctx())).kind).toBe("unknown")
    refundTransaction.mockResolvedValue({ id: 99 })
    expect((await paystackGateway.refund(ctx())).kind).toBe("unknown")
  })
  it("refund() without a refund id is unknown (cannot be re-checked), whatever the status", async () => {
    for (const data of [{ status: "processed" }, { status: "failed" }, { id: null, status: "pending" }, { id: "", status: "pending" }, null, undefined]) {
      refundTransaction.mockResolvedValue(data)
      const out = await paystackGateway.refund(ctx())
      expect(out.kind).toBe("unknown")
      expect((out as { error: string }).error).toMatch(/no refund id/)
    }
  })
  it("maps an API rejection to failed", async () => {
    refundTransaction.mockRejectedValue(Object.assign(new Error("Transaction has already been fully reversed"), { httpStatus: 422 }))
    expect(await paystackGateway.refund(ctx())).toEqual({ kind: "failed", error: "Transaction has already been fully reversed" })
  })
  it("maps a network failure to unknown (money may have moved)", async () => {
    refundTransaction.mockRejectedValue(new TypeError("fetch failed"))
    expect((await paystackGateway.refund(ctx())).kind).toBe("unknown")
  })
  it("treats anything but a 4xx rejection as unknown", async () => {
    refundTransaction.mockRejectedValue(Object.assign(new Error("Bad gateway"), { httpStatus: 502 }))
    expect((await paystackGateway.refund(ctx())).kind).toBe("unknown")
    refundTransaction.mockRejectedValue(new SyntaxError("Unexpected token <"))
    expect((await paystackGateway.refund(ctx())).kind).toBe("unknown")
    refundTransaction.mockRejectedValue(new DOMException("aborted", "AbortError"))
    expect((await paystackGateway.refund(ctx())).kind).toBe("unknown")
    refundTransaction.mockRejectedValue(new Error("no status attached"))
    expect((await paystackGateway.refund(ctx())).kind).toBe("unknown")
  })
})

describe("mapPaystackRefundStatus", () => {
  it.each([
    ["processed", "completed"], ["PROCESSED", "completed"], ["  Processed ", "completed"],
    ["pending", "pending"], ["Processing", "pending"], ["needs-attention", "pending"], ["needs_attention", "pending"], [" NEEDS-ATTENTION ", "pending"],
    ["failed", "failed"], ["FAILED", "failed"],
    ["reversed", "unknown"], ["", "unknown"], ["success", "unknown"],
    [undefined, "unknown"], [null, "unknown"], [42, "unknown"], [{}, "unknown"], [["processed"], "unknown"],
  ])("%j -> %s", (status, kind) => {
    expect(mapPaystackRefundStatus(status, "7").kind).toBe(kind)
  })
  it("carries the ref on completed/pending", () => {
    expect(mapPaystackRefundStatus("processed", "7")).toEqual({ kind: "completed", ref: "7" })
    expect(mapPaystackRefundStatus("pending", "7")).toEqual({ kind: "pending", ref: "7" })
  })
})

describe("paystackGateway.checkStatus", () => {
  const check = (ref: string | null) => paystackGateway.checkStatus!(ctx(), ref)
  it("fetches the refund by id and maps its status", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "processed" })
    expect(await check("99")).toEqual({ kind: "completed", ref: "99" })
    expect(fetchRefund).toHaveBeenCalledWith("99")
    fetchRefund.mockResolvedValue({ id: 99, status: "processing" })
    expect(await check("99")).toEqual({ kind: "pending", ref: "99" })
    fetchRefund.mockResolvedValue({ id: 99, status: "failed" })
    expect((await check("99")).kind).toBe("failed")
  })
  it("missing / non-numeric refs are unknown and never call Paystack", async () => {
    for (const ref of [null, "", "  ", "ref-1", "12abc", "../x", "1 2"]) expect((await check(ref)).kind).toBe("unknown")
    expect(fetchRefund).not.toHaveBeenCalled()
  })
  it("HTTP / network errors are unknown, never failed", async () => {
    for (const err of [
      Object.assign(new Error("not found"), { httpStatus: 404 }),
      Object.assign(new Error("bad request"), { httpStatus: 400 }),
      Object.assign(new Error("server"), { httpStatus: 500 }),
      new TypeError("fetch failed"), new SyntaxError("Unexpected token <"),
    ]) {
      fetchRefund.mockRejectedValue(err)
      expect((await check("99")).kind).toBe("unknown")
    }
  })
  it("an unrecognised or missing status is unknown", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "mystery" })
    expect((await check("99")).kind).toBe("unknown")
    fetchRefund.mockResolvedValue(null)
    expect((await check("99")).kind).toBe("unknown")
  })
  it("describePaystackRefund exposes the raw status", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "needs-attention" })
    const d = await describePaystackRefund("99")
    expect(d.rawStatus).toBe("needs-attention")
    expect(d.outcome.kind).toBe("pending")
    fetchRefund.mockRejectedValue(new Error("x"))
    expect((await describePaystackRefund("99")).rawStatus).toBeNull()
  })
})

describe("paystackPayoutGateway", () => {
  it("needs a payer number on a recognised MoMo network", () => {
    expect(paystackPayoutGateway.supports(order()).ok).toBe(true)
    expect(paystackPayoutGateway.supports(order({ payment: { gateway: "paystack", reference: "r", payerPhone: null, walletUserId: null } })).ok).toBe(false)
    expect(paystackPayoutGateway.supports(order({ payment: { gateway: null, reference: null, payerPhone: "0111112222", walletUserId: null } })).ok).toBe(false)
  })

  it("creates a mobile_money recipient, then a transfer keyed by the refund id, and returns otp", async () => {
    createRecipient.mockResolvedValue({ recipientCode: "RCP_1" })
    psTransfer.mockResolvedValue({ status: "otp", rawStatus: "otp", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    const out = await paystackPayoutGateway.refund(ctx())
    expect(createRecipient).toHaveBeenCalledWith(expect.objectContaining({ accountNumber: "0241112222", bankCode: "MTN", type: "mobile_money" }))
    expect(psTransfer).toHaveBeenCalledWith(expect.objectContaining({ recipientCode: "RCP_1", amount: 9.5, reference: "rf-1" }))
    expect(out).toEqual({ kind: "otp", ref: "TRF_1" })
  })

  it("maps the other transfer statuses", async () => {
    createRecipient.mockResolvedValue({ recipientCode: "RCP_1" })
    psTransfer.mockResolvedValue({ status: "success", rawStatus: "success", transferCode: "TRF_2", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "completed", ref: "TRF_2" })
    psTransfer.mockResolvedValue({ status: "pending", rawStatus: "pending", transferCode: "TRF_3", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "pending", ref: "TRF_3" })
    psTransfer.mockResolvedValue({ status: "failed", rawStatus: "failed", transferCode: "", transactionReference: "rf-1", fee: 0, errorMessage: "Insufficient balance" })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "failed", error: "Insufficient balance" })
    psTransfer.mockResolvedValue(null)
    expect((await paystackPayoutGateway.refund(ctx())).kind).toBe("unknown")
  })

  it("only calls it failed on a definitive rejection; ambiguity is unknown", async () => {
    createRecipient.mockResolvedValue({ recipientCode: "RCP_1" })
    const t = (r: object) => { psTransfer.mockResolvedValue({ transferCode: "TRF_9", transactionReference: "rf-1", fee: 0, ...r }) }
    t({ status: "failed", rawStatus: "reversed", errorMessage: "x" })
    expect((await paystackPayoutGateway.refund(ctx())).kind).toBe("failed")
    t({ status: "failed", rawStatus: "processing" })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "pending", ref: "TRF_9" })
    t({ status: "failed", rawStatus: "weird" })
    expect((await paystackPayoutGateway.refund(ctx())).kind).toBe("unknown")
    t({ status: "failed", rawStatus: "", httpStatus: 502, errorMessage: "Bad gateway" })
    expect((await paystackPayoutGateway.refund(ctx())).kind).toBe("unknown")
    t({ status: "failed", rawStatus: "", httpStatus: 400, errorMessage: "Transfer with this reference already exists" })
    expect((await paystackPayoutGateway.refund(ctx())).kind).toBe("unknown")
    t({ status: "failed", rawStatus: "", httpStatus: 422, errorMessage: "Insufficient balance" })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "failed", error: "Insufficient balance" })
  })

  it("fails definitively (nothing sent) when the recipient cannot be created", async () => {
    createRecipient.mockResolvedValue({ error: "Invalid bank code" })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "failed", error: "Invalid bank code" })
    expect(psTransfer).not.toHaveBeenCalled()
  })

  it("finalizes with the admin's OTP; a rejected OTP stays awaiting (never failed)", async () => {
    psFinalize.mockResolvedValue({ status: "success", rawStatus: "success", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "123456")).toEqual({ kind: "completed", ref: "TRF_1" })
    expect(psFinalize).toHaveBeenCalledWith("TRF_1", "123456")

    psFinalize.mockResolvedValue({ status: "failed", transferCode: "TRF_1", transactionReference: "", fee: 0, errorMessage: "Invalid OTP" })
    expect(await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "000000")).toEqual({ kind: "otp", ref: "TRF_1" })

    psFinalize.mockResolvedValue({ status: "pending", rawStatus: "pending", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "123456")).toEqual({ kind: "pending", ref: "TRF_1" })
    psFinalize.mockResolvedValue(null)
    expect((await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "123456")).kind).toBe("unknown")
  })

  it("reconciles by transfer reference (the refund id)", async () => {
    psStatus.mockResolvedValue({ status: "success", rawStatus: "success", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).toEqual({ kind: "completed", ref: "TRF_1" })
    psStatus.mockResolvedValue({ status: "otp", rawStatus: "otp", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect((await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).kind).toBe("otp")
    psStatus.mockResolvedValue({ status: "failed", rawStatus: "reversed", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0, errorMessage: "reversed" })
    expect(await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).toEqual({ kind: "failed", error: "reversed" })
    psStatus.mockResolvedValue(null)
    expect((await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).kind).toBe("unknown")
  })
})

describe("moolreGateway", () => {
  it("maps phone prefixes to Moolre networks", () => {
    expect(momoNetworkForMoolre("0241112222")).toBe("MTN")
    expect(momoNetworkForMoolre("0201112222")).toBe("TELECEL")
    expect(momoNetworkForMoolre("0271112222")).toBe("AT")
    expect(momoNetworkForMoolre("0111112222")).toBeNull()
  })
  it("is unsupported when there is no usable payer number", () => {
    expect(moolreGateway.supports(order({ payment: { gateway: "paystack", reference: "r", payerPhone: null, walletUserId: null } })).ok).toBe(false)
  })
  it("uses the refund id as the idempotency reference and maps txstatus", async () => {
    moolreTransfer.mockResolvedValue({ txstatus: 1, transactionId: "T1", externalref: "rf-1", fee: 0 })
    expect(await moolreGateway.refund(ctx())).toEqual({ kind: "completed", ref: "T1" })
    expect(moolreTransfer).toHaveBeenCalledWith(expect.objectContaining({ externalref: "rf-1", phone: "0241112222", network: "MTN", amount: 9.5 }))

    moolreTransfer.mockResolvedValue({ txstatus: 0, transactionId: "T2", externalref: "rf-1", fee: 0 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("pending")
    moolreTransfer.mockResolvedValue({ txstatus: 2, transactionId: "", externalref: "rf-1", fee: 0, errorMessage: "rejected", parsed: true, httpStatus: 200 })
    expect(await moolreGateway.refund(ctx())).toEqual({ kind: "failed", error: "rejected" })
    moolreTransfer.mockResolvedValue({ txstatus: 3, transactionId: "", externalref: "rf-1", fee: 0 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("unknown")
    moolreTransfer.mockResolvedValue(null)
    expect((await moolreGateway.refund(ctx())).kind).toBe("unknown")
  })
  it("only calls it failed on a parsed, non-5xx rejection; ambiguity is unknown", async () => {
    const m = (r: object) => moolreTransfer.mockResolvedValue({ txstatus: 2, transactionId: "", externalref: "rf-1", fee: 0, errorMessage: "e", ...r })
    m({ parsed: false, httpStatus: 200 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("unknown")
    m({ parsed: false, httpStatus: 502 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("unknown")
    m({ parsed: true, httpStatus: 502 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("unknown")
    m({ insufficientBalance: true, parsed: true, httpStatus: 500 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("failed")
    m({ parsed: true, httpStatus: 400 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("failed")
  })
  it("falls back to the refund id when Moolre returns no transaction id", async () => {
    moolreTransfer.mockResolvedValue({ txstatus: 1, transactionId: "", externalref: "rf-1", fee: 0, parsed: true, httpStatus: 200 })
    expect(await moolreGateway.refund(ctx())).toEqual({ kind: "completed", ref: "rf-1" })
    moolreTransfer.mockResolvedValue({ txstatus: 0, transactionId: "", externalref: "rf-1", fee: 0, parsed: true, httpStatus: 200 })
    expect(await moolreGateway.refund(ctx())).toEqual({ kind: "pending", ref: "rf-1" })
    moolreStatus.mockResolvedValue({ txstatus: 1, transactionId: "", externalref: "rf-1" })
    expect(await moolreGateway.checkStatus!(ctx(), null)).toEqual({ kind: "completed", ref: "rf-1" })
  })
  it("reconciles by external reference", async () => {
    moolreStatus.mockResolvedValue({ txstatus: 1, transactionId: "T9", externalref: "rf-1" })
    expect(await moolreGateway.checkStatus!(ctx(), null)).toEqual({ kind: "completed", ref: "T9" })
    moolreStatus.mockResolvedValue(null)
    expect((await moolreGateway.checkStatus!(ctx(), null)).kind).toBe("unknown")
  })
})

describe("walletGateway", () => {
  const walletOrder = { payment: { gateway: "wallet" as const, reference: null, payerPhone: null, walletUserId: "u1" } }
  it("requires a resolvable wallet owner", () => {
    expect(walletGateway.supports(order(walletOrder)).ok).toBe(true)
    expect(walletGateway.supports(order({ payment: { gateway: "paystack", reference: "r", payerPhone: "024", walletUserId: null } })).ok).toBe(false)
  })
  it("credits idempotently by refund id", async () => {
    rpc.mockResolvedValue({ data: [{ new_balance: 20, already_processed: false }], error: null })
    const out = await walletGateway.refund({ ...ctx(walletOrder), destinationPhone: null })
    expect(rpc).toHaveBeenCalledWith("credit_wallet_safely", expect.objectContaining({
      p_user_id: "u1", p_amount: 9.5, p_reference_id: "REFUND_rf-1",
    }))
    expect(out).toEqual({ kind: "completed", ref: "REFUND_rf-1" })
  })
  it("treats an RPC error as unknown (the credit is idempotent so a re-check is safe)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "timeout" } })
    expect((await walletGateway.refund({ ...ctx(walletOrder), destinationPhone: null })).kind).toBe("unknown")
  })
})
