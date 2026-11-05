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

describe("payment gateway does not change eligibility (Hubtel vs Paystack)", () => {
  // The shared charge handler marks a Hubtel-paid order payment_status 'completed', exactly like a Paystack one.
  it("a Hubtel-paid USSD order never sent anywhere is refundable like a Paystack one", () => {
    expect(code({ table: "ussd_orders" })).toBe("ok")
    expect(code({ table: "ussd_shop_orders" })).toBe("ok")
  })
  it("'abandoned' is only a provider TRACKING status here; it never stands for the payment", () => {
    // a paid order whose only provider attempt was abandoned stays refundable
    expect(code({ table: "ussd_orders", dispatchOutcome: "submitted", trackingStatuses: ["abandoned"] })).toBe("ok")
  })
  it("an order whose payment_status a verifier set to abandoned is never refundable (fails closed)", () => {
    expect(code({ table: "shop_orders", paymentStatus: "abandoned" })).toBe("NOT_PENDING")
    expect(code({ table: "ussd_orders", paymentStatus: "abandoned" })).toBe("NOT_PENDING")
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
  it("a Hubtel collection is refused on every table, with a message that says why", () => {
    expect(code({ hubtelCollection: true })).toBe("HUBTEL_COLLECTION")
    expect(code({ table: "hubtel_bill_orders", hubtelCollection: true })).toBe("HUBTEL_COLLECTION")
    const r = evaluateEligibility({ ...base, hubtelCollection: true })
    expect(r.eligible ? "" : r.reason).toMatch(/Hubtel/)
  })

  describe("Hubtel collections by attempt status", () => {
    it.each(["pending", "confirming", "needs_review"])("a %s attempt stays refused: the money may not have landed, or may still land", (s) => {
      expect(code({ hubtelCollection: true, hubtelAttemptStatus: s })).toBe("HUBTEL_COLLECTION")
      expect(code({ table: "hubtel_bill_orders", hubtelCollection: true, hubtelAttemptStatus: s })).toBe("HUBTEL_COLLECTION")
    })
    it("an unknown or missing status fails closed", () => {
      expect(code({ hubtelCollection: true })).toBe("HUBTEL_COLLECTION")
      expect(code({ hubtelCollection: true, hubtelAttemptStatus: "weird" })).toBe("HUBTEL_COLLECTION")
    })
    it("a paid attempt falls through to the ordinary checks", () => {
      expect(code({ hubtelCollection: true, hubtelAttemptStatus: "paid" })).toBe("ok")
      expect(code({ hubtelCollection: true, hubtelAttemptStatus: "paid", orderStatus: "processing" })).toBe("NOT_PENDING")
      expect(code({ hubtelCollection: true, hubtelAttemptStatus: "paid", hasActiveRefund: true })).toBe("ALREADY_REFUNDED")
      expect(code({ hubtelCollection: true, hubtelAttemptStatus: "paid", trackingStatuses: ["completed"] })).toBe("SENT_TO_PROVIDER")
      expect(code({ hubtelCollection: true, hubtelAttemptStatus: "paid", dispatchOutcome: "claimed" })).toBe("DISPATCH_IN_PROGRESS")
    })
    it("a Paystack-paid order (no Hubtel collection) is untouched by the attempt status", () => {
      expect(code({})).toBe("ok")
      expect(code({ hubtelAttemptStatus: "pending" })).toBe("ok")
    })
  })
})
