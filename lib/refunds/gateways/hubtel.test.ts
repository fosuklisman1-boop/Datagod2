import type { RefundableOrder, RefundContext } from "../types"

const requestHubtelRefund = vi.fn()
vi.mock("../hubtel-refund", () => ({
  requestHubtelRefund: (...a: unknown[]) => requestHubtelRefund(...a),
}))

import { hubtelGateway } from "./hubtel"

const DAY = 86_400_000
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString()

const order = (hubtel: Partial<NonNullable<RefundableOrder["payment"]["hubtel"]>> | null = {}, o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "ussd_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: null, shopName: null, packageLabel: "2", network: "MTN", recipientPhone: "0241112222",
  createdAt: "2026-10-05", paid: 10, gatewayFee: 0,
  payment: {
    gateway: "hubtel", reference: null, payerPhone: "0241112222", walletUserId: null,
    // Realistic prod shape: gross amountPaid includes Hubtel's customer fee; net amountAfterCharges = the order price.
    ...(hubtel ? { hubtel: { orderId: "HUB-1", amountPaid: 10.3, amountAfterCharges: 10, paidAt: daysAgo(1), paidRows: 1, ...hubtel } } : {}),
  },
  owners: [], evidence: { hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null },
  ...o,
})
const ctx = (o: RefundableOrder = order(), amount = 10): RefundContext => ({ refundId: "rf-1", order: o, amount, destinationPhone: null })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("HUBTEL_REFUND_ENABLED", "true")
})
afterEach(() => vi.unstubAllEnvs())

describe("hubtelGateway identity", () => {
  it("has the expected id and label", () => {
    expect(hubtelGateway.id).toBe("hubtel")
    expect(hubtelGateway.label).toBe("Hubtel (refund to payer)")
  })
})

describe("hubtelGateway.supports", () => {
  it("is offered for a recent, single-row, whole-cedi Hubtel payment", () => {
    expect(hubtelGateway.supports(order())).toEqual({ ok: true })
  })
  it.each([undefined, "false", "", "TRUE"])("is hidden unless HUBTEL_REFUND_ENABLED is exactly 'true' (%s)", (v) => {
    if (v === undefined) vi.stubEnv("HUBTEL_REFUND_ENABLED", undefined as unknown as string)
    else vi.stubEnv("HUBTEL_REFUND_ENABLED", v)
    expect(hubtelGateway.supports(order())).toEqual({ ok: false, reason: "Hubtel refunds are not enabled" })
  })
  it("needs payment.hubtel", () => {
    expect(hubtelGateway.supports(order(null))).toEqual({ ok: false, reason: "Not paid through Hubtel" })
  })
  it("refuses more than one paid row and says to refund manually", () => {
    const s = hubtelGateway.supports(order({ paidRows: 2 }))
    expect(s.ok).toBe(false)
    if (!s.ok) expect(s.reason).toMatch(/refund manually/)
  })
  it("refuses zero paid rows too", () => {
    expect(hubtelGateway.supports(order({ paidRows: 0 })).ok).toBe(false)
  })
  it("enforces the 45-day limit as 44 days", () => {
    expect(hubtelGateway.supports(order({ paidAt: daysAgo(45) })).ok).toBe(false)
    expect(hubtelGateway.supports(order({ paidAt: daysAgo(44.5) })).ok).toBe(false)
    expect(hubtelGateway.supports(order({ paidAt: daysAgo(43) })).ok).toBe(true)
  })
  it("fails closed on an unparseable paidAt", () => {
    expect(hubtelGateway.supports(order({ paidAt: "garbage" })).ok).toBe(false)
  })
  it("refuses gross amounts under GHS 1.00 (Hubtel 4000)", () => {
    expect(hubtelGateway.supports(order({ amountPaid: 0.5 })).ok).toBe(false)
    expect(hubtelGateway.supports(order({ amountPaid: 1 })).ok).toBe(true)
  })
  it("is ok when the gross includes Hubtel's fee and the net equals the order price (realistic prod row)", () => {
    expect(hubtelGateway.supports(order({ amountPaid: 10.3, amountAfterCharges: 10 }))).toEqual({ ok: true })
    // gross far above the order price is no longer a refusal on its own
    expect(hubtelGateway.supports(order({ amountPaid: 11.09, amountAfterCharges: 10 })).ok).toBe(true)
    expect(hubtelGateway.supports(order({ amountAfterCharges: 10.004 })).ok).toBe(true)
  })
  it("refuses when the net amount does not match the order price", () => {
    expect(hubtelGateway.supports(order({ amountPaid: 10.3, amountAfterCharges: 9.5 }))).toEqual({
      ok: false, reason: "Hubtel net amount GHS 9.50 does not match the order price GHS 10.00 — refund manually",
    })
    expect(hubtelGateway.supports(order({ amountAfterCharges: 10.5 })).ok).toBe(false)
    expect(hubtelGateway.supports(order({ amountAfterCharges: 10.006 })).ok).toBe(false)
  })
  it("refuses a missing, non-finite or sub-GHS-1 net amount", () => {
    for (const net of [null, NaN, Infinity]) {
      const s = hubtelGateway.supports(order({ amountAfterCharges: net }))
      expect(s.ok, String(net)).toBe(false)
      if (!s.ok) expect(s.reason).toMatch(/does not match the order price GHS 10\.00 — refund manually/)
    }
    expect(hubtelGateway.supports(order({ amountPaid: 1.2, amountAfterCharges: 0.9 }, { paid: 0.9 })).ok).toBe(false)
  })
  it("refuses non-finite gross amounts", () => {
    expect(hubtelGateway.supports(order({ amountPaid: NaN })).ok).toBe(false)
  })
  it("is not offered on wallet-only tables", () => {
    for (const table of ["orders", "api_orders"] as const) {
      expect(hubtelGateway.supports(order({}, { table })), table).toEqual({ ok: false, reason: "Paid from wallet — refund goes back to the buyer's wallet" })
    }
  })
})

describe("hubtelGateway.fixedAmount", () => {
  it("is the order price (net), never the gross Hubtel collected", () => {
    expect(hubtelGateway.fixedAmount!(order({ amountPaid: 10.3, amountAfterCharges: 10 }))).toBe(10)
    expect(hubtelGateway.fixedAmount!(order({}, { paid: 12.499999 }))).toBe(12.5)
  })
  it("is null when there is no Hubtel payment", () => {
    expect(hubtelGateway.fixedAmount!(order(null))).toBeNull()
  })
})

describe("hubtelGateway.refund", () => {
  it("requests the refund by Hubtel order id and refund id and returns the outcome", async () => {
    requestHubtelRefund.mockResolvedValue({ kind: "pending", ref: "HUB-1" })
    expect(await hubtelGateway.refund(ctx())).toEqual({ kind: "pending", ref: "HUB-1" })
    expect(requestHubtelRefund).toHaveBeenCalledWith("HUB-1", "rf-1")
  })
  it("passes a failed outcome through", async () => {
    requestHubtelRefund.mockResolvedValue({ kind: "failed", error: "nope" })
    expect(await hubtelGateway.refund(ctx())).toEqual({ kind: "failed", error: "nope" })
  })
  it("rejects a partial amount WITHOUT calling Hubtel", async () => {
    expect(await hubtelGateway.refund(ctx(order(), 9.5))).toEqual({ kind: "failed", error: "Hubtel refunds the full amount only" })
    expect(requestHubtelRefund).not.toHaveBeenCalled()
  })
  it("rejects the gross amount (10.30) WITHOUT calling Hubtel; the net (10.00) calls Hubtel", async () => {
    expect(await hubtelGateway.refund(ctx(order(), 10.3))).toEqual({ kind: "failed", error: "Hubtel refunds the full amount only" })
    expect(requestHubtelRefund).not.toHaveBeenCalled()
    requestHubtelRefund.mockResolvedValue({ kind: "pending", ref: "HUB-1" })
    expect((await hubtelGateway.refund(ctx(order(), 10))).kind).toBe("pending")
    expect(requestHubtelRefund).toHaveBeenCalledWith("HUB-1", "rf-1")
  })
  it("fails (no call) when the net amount is unknown", async () => {
    expect(await hubtelGateway.refund(ctx(order({ amountAfterCharges: null }), 10))).toMatchObject({ kind: "failed" })
    expect(requestHubtelRefund).not.toHaveBeenCalled()
  })
  it("tolerates sub-half-pesewa float noise", async () => {
    requestHubtelRefund.mockResolvedValue({ kind: "pending", ref: "HUB-1" })
    expect((await hubtelGateway.refund(ctx(order(), 10.004))).kind).toBe("pending")
  })
  it("fails (no call) when the order has no Hubtel payment", async () => {
    expect((await hubtelGateway.refund(ctx(order(null)))).kind).toBe("failed")
    expect(requestHubtelRefund).not.toHaveBeenCalled()
  })
})

describe("hubtelGateway.checkStatus", () => {
  const UNKNOWN = {
    kind: "unknown",
    error: "Hubtel has no refund-status lookup — waiting for Hubtel's callback; confirm with Hubtel before resolving",
  }
  it("is unknown (no lookup exists; the callback settles it) so the stored ref is kept", async () => {
    expect(await hubtelGateway.checkStatus!(ctx(), "HUB-9")).toEqual(UNKNOWN)
  })
  it("is unknown without a stored ref too", async () => {
    expect(await hubtelGateway.checkStatus!(ctx(), null)).toEqual(UNKNOWN)
  })
})
