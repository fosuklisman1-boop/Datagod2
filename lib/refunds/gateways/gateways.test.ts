import type { RefundableOrder, RefundContext } from "../types"

const refundTransaction = vi.fn()
const moolreTransfer = vi.fn()
const moolreStatus = vi.fn()
const rpc = vi.fn()

vi.mock("@/lib/paystack", () => ({ refundTransaction: (...a: unknown[]) => refundTransaction(...a) }))
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

import { paystackGateway } from "./paystack"
import { paystackPayoutGateway } from "./paystack-payout"
import { moolreGateway, momoNetworkForMoolre } from "./moolre"
import { walletGateway } from "./wallet"
import { getGateway, listGateways } from "./index"

const order = (o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "ussd_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: null, shopName: null, packageLabel: "2", network: "MTN", recipientPhone: "0241112222",
  createdAt: "2026-10-05", paid: 10, gatewayFee: 0,
  payment: { gateway: "paystack", reference: "ref-1", payerPhone: "0241112222", walletUserId: null },
  owners: [], evidence: { hasActiveRefund: false, dispatchOutcome: null, trackingStatuses: [], externalOrderId: null },
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
    expect(out).toEqual({ kind: "completed", ref: "99" })
  })
  it("maps an API rejection to failed", async () => {
    refundTransaction.mockRejectedValue(new Error("Transaction has already been fully reversed"))
    expect(await paystackGateway.refund(ctx())).toEqual({ kind: "failed", error: "Transaction has already been fully reversed" })
  })
  it("maps a network failure to unknown (money may have moved)", async () => {
    refundTransaction.mockRejectedValue(new TypeError("fetch failed"))
    expect((await paystackGateway.refund(ctx())).kind).toBe("unknown")
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
    psTransfer.mockResolvedValue({ status: "otp", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    const out = await paystackPayoutGateway.refund(ctx())
    expect(createRecipient).toHaveBeenCalledWith(expect.objectContaining({ accountNumber: "0241112222", bankCode: "MTN", type: "mobile_money" }))
    expect(psTransfer).toHaveBeenCalledWith(expect.objectContaining({ recipientCode: "RCP_1", amount: 9.5, reference: "rf-1" }))
    expect(out).toEqual({ kind: "otp", ref: "TRF_1" })
  })

  it("maps the other transfer statuses", async () => {
    createRecipient.mockResolvedValue({ recipientCode: "RCP_1" })
    psTransfer.mockResolvedValue({ status: "success", transferCode: "TRF_2", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "completed", ref: "TRF_2" })
    psTransfer.mockResolvedValue({ status: "pending", transferCode: "TRF_3", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "pending", ref: "TRF_3" })
    psTransfer.mockResolvedValue({ status: "failed", transferCode: "", transactionReference: "rf-1", fee: 0, errorMessage: "Insufficient balance" })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "failed", error: "Insufficient balance" })
    psTransfer.mockResolvedValue(null)
    expect((await paystackPayoutGateway.refund(ctx())).kind).toBe("unknown")
  })

  it("fails definitively (nothing sent) when the recipient cannot be created", async () => {
    createRecipient.mockResolvedValue({ error: "Invalid bank code" })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "failed", error: "Invalid bank code" })
    expect(psTransfer).not.toHaveBeenCalled()
  })

  it("finalizes with the admin's OTP; a rejected OTP stays awaiting (never failed)", async () => {
    psFinalize.mockResolvedValue({ status: "success", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "123456")).toEqual({ kind: "completed", ref: "TRF_1" })
    expect(psFinalize).toHaveBeenCalledWith("TRF_1", "123456")

    psFinalize.mockResolvedValue({ status: "failed", transferCode: "TRF_1", transactionReference: "", fee: 0, errorMessage: "Invalid OTP" })
    expect(await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "000000")).toEqual({ kind: "otp", ref: "TRF_1" })

    psFinalize.mockResolvedValue({ status: "pending", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "123456")).toEqual({ kind: "pending", ref: "TRF_1" })
    psFinalize.mockResolvedValue(null)
    expect((await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "123456")).kind).toBe("unknown")
  })

  it("reconciles by transfer reference (the refund id)", async () => {
    psStatus.mockResolvedValue({ status: "success", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).toEqual({ kind: "completed", ref: "TRF_1" })
    psStatus.mockResolvedValue({ status: "otp", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect((await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).kind).toBe("otp")
    psStatus.mockResolvedValue({ status: "failed", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0, errorMessage: "reversed" })
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
    moolreTransfer.mockResolvedValue({ txstatus: 2, transactionId: "", externalref: "rf-1", fee: 0, errorMessage: "rejected" })
    expect(await moolreGateway.refund(ctx())).toEqual({ kind: "failed", error: "rejected" })
    moolreTransfer.mockResolvedValue({ txstatus: 3, transactionId: "", externalref: "rf-1", fee: 0 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("unknown")
    moolreTransfer.mockResolvedValue(null)
    expect((await moolreGateway.refund(ctx())).kind).toBe("unknown")
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
