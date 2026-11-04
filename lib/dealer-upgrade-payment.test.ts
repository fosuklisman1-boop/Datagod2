import { describe, expect, it } from "vitest"
import { checkUpgradeInitRequest, isDealerUpgradeFullyPaid } from "./dealer-upgrade-payment"

describe("checkUpgradeInitRequest", () => {
  const valid = { orderId: undefined, planId: "plan1", userId: "u1" }

  it("accepts a logged-in request for a plan with no order attached", () => {
    expect(checkUpgradeInitRequest(valid)).toEqual({ ok: true })
  })

  it("refuses an upgrade carrying an orderId (it would be priced from the order)", () => {
    expect(checkUpgradeInitRequest({ ...valid, orderId: "o1" })).toMatchObject({ ok: false, status: 400 })
  })

  it("refuses an upgrade with no planId (it would fall through to a client-set amount)", () => {
    expect(checkUpgradeInitRequest({ ...valid, planId: undefined })).toMatchObject({ ok: false, status: 400 })
    expect(checkUpgradeInitRequest({ ...valid, planId: "" })).toMatchObject({ ok: false, status: 400 })
  })

  it("refuses an upgrade with no logged-in user", () => {
    expect(checkUpgradeInitRequest({ ...valid, userId: undefined })).toMatchObject({ ok: false, status: 401 })
  })
})

describe("isDealerUpgradeFullyPaid", () => {
  it("accepts the plan price plus fee, including the amounts real upgrades paid", () => {
    expect(isDealerUpgradeFullyPaid({ paidPesewas: 2060, feeGhs: 0.6, planPriceGhs: 20 })).toBe(true)
    expect(isDealerUpgradeFullyPaid({ paidPesewas: 10300, feeGhs: 3, planPriceGhs: 100 })).toBe(true)
    expect(isDealerUpgradeFullyPaid({ paidPesewas: 20599, feeGhs: 6, planPriceGhs: 199.99 })).toBe(true)
  })

  it("accepts a missing fee and an overpayment", () => {
    expect(isDealerUpgradeFullyPaid({ paidPesewas: 2000, feeGhs: null, planPriceGhs: 20 })).toBe(true)
    expect(isDealerUpgradeFullyPaid({ paidPesewas: 5000, feeGhs: 0.6, planPriceGhs: 20 })).toBe(true)
  })

  it("refuses a cheap order's amount", () => {
    expect(isDealerUpgradeFullyPaid({ paidPesewas: 103, feeGhs: 0.03, planPriceGhs: 20 })).toBe(false)
  })

  it("does not let the fee count toward the plan price", () => {
    expect(isDealerUpgradeFullyPaid({ paidPesewas: 2000, feeGhs: 0.6, planPriceGhs: 20 })).toBe(false)
  })

  it("refuses when any number is unusable", () => {
    expect(isDealerUpgradeFullyPaid({ paidPesewas: Number.NaN, feeGhs: 0, planPriceGhs: 20 })).toBe(false)
    expect(isDealerUpgradeFullyPaid({ paidPesewas: 2000, feeGhs: 0, planPriceGhs: Number.NaN })).toBe(false)
    expect(isDealerUpgradeFullyPaid({ paidPesewas: 2000, feeGhs: Number.NaN, planPriceGhs: 20 })).toBe(false)
  })
})
