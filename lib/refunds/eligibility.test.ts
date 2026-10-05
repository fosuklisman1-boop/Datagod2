import { evaluateEligibility, refundableStatuses, type EligibilityInput } from "./eligibility"

const base: EligibilityInput = {
  orderStatus: "pending", paymentStatus: "completed", hasActiveRefund: false,
  dispatchOutcome: null, trackingStatuses: [], externalOrderId: null,
}
const code = (o: Partial<EligibilityInput>) => {
  const r = evaluateEligibility({ ...base, ...o })
  return r.eligible ? "ok" : r.code
}

describe("evaluateEligibility", () => {
  it("accepts a paid pending order never sent anywhere", () => expect(code({})).toBe("ok"))
  it("rejects non-pending orders", () => expect(code({ orderStatus: "processing" })).toBe("NOT_PENDING"))
  it("rejects unpaid orders", () => expect(code({ paymentStatus: "pending" })).toBe("NOT_PENDING"))
  it("rejects an order with an active refund", () => expect(code({ hasActiveRefund: true })).toBe("ALREADY_REFUNDED"))
  it("rejects while a dispatch is claimed (in flight)", () => expect(code({ dispatchOutcome: "claimed" })).toBe("DISPATCH_IN_PROGRESS"))
  it("rejects an unknown dispatch outcome", () => expect(code({ dispatchOutcome: "unknown" })).toBe("DISPATCH_UNKNOWN"))
  it("accepts when dispatch outcome is failed and there are no tracking rows", () => expect(code({ dispatchOutcome: "failed" })).toBe("ok"))
  it("accepts a submitted order whose every tracking row is terminally failed", () => {
    expect(code({ dispatchOutcome: "submitted", trackingStatuses: ["failed", "abandoned", "error"] })).toBe("ok")
  })
  it("rejects when any tracking row is still pending/retrying/completed", () => {
    expect(code({ trackingStatuses: ["failed", "pending"] })).toBe("PROVIDER_IN_PROGRESS")
    expect(code({ trackingStatuses: ["failed", "retrying"] })).toBe("PROVIDER_IN_PROGRESS")
    expect(code({ trackingStatuses: ["failed", "completed"] })).toBe("SENT_TO_PROVIDER")
  })
  it("rejects a submitted order with no tracking rows (cannot prove failure)", () => {
    expect(code({ dispatchOutcome: "submitted", trackingStatuses: [] })).toBe("SENT_TO_PROVIDER")
  })
  it("rejects an order with an external id and no tracking rows (pre-guard dispatch)", () => {
    expect(code({ externalOrderId: "12345" })).toBe("SENT_TO_PROVIDER")
  })
})

describe("refundableStatuses / per-table status", () => {
  it("lists the refundable statuses per table", () => {
    expect(refundableStatuses("shop_orders")).toEqual(["pending"])
    expect(refundableStatuses("ussd_orders")).toEqual(["pending"])
    expect(refundableStatuses("ussd_shop_orders")).toEqual(["pending"])
    expect(refundableStatuses("orders")).toEqual(["pending"])
    expect(refundableStatuses("api_orders")).toEqual(["pending", "held_registration"])
  })
  it("a held_registration api order with no tracking is eligible", () => {
    expect(code({ table: "api_orders", orderStatus: "held_registration" })).toBe("ok")
  })
  it("held_registration is not refundable on orders or the original tables", () => {
    expect(code({ table: "orders", orderStatus: "held_registration" })).toBe("NOT_PENDING")
    expect(code({ table: "shop_orders", orderStatus: "held_registration" })).toBe("NOT_PENDING")
  })
  it("processing is NOT_PENDING on the new tables", () => {
    expect(code({ table: "orders", orderStatus: "processing" })).toBe("NOT_PENDING")
    expect(code({ table: "api_orders", orderStatus: "processing" })).toBe("NOT_PENDING")
  })
  it("a table-less input behaves like the original tables (pending only)", () => {
    expect(code({ orderStatus: "held_registration" })).toBe("NOT_PENDING")
  })
})
