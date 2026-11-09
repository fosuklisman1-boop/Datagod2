import { describe, expect, it } from "vitest"
import { checkUpgradeInitRequest, isDealerUpgradeFullyPaid } from "./dealer-upgrade-payment"

describe("checkUpgradeInitRequest", () => {
  const PLAN = "4d05cda6-4e1b-42ec-841d-f4c9a41fb79b"
  const valid = { type: "dealer_upgrade", orderId: undefined, planId: PLAN, userId: "u1" }

  it("accepts a logged-in request for a plan with no order attached", () => {
    expect(checkUpgradeInitRequest(valid)).toEqual({ ok: true })
  })

  it("leaves every other kind of payment alone", () => {
    expect(checkUpgradeInitRequest({ orderId: "o1" })).toEqual({ ok: true })
    expect(checkUpgradeInitRequest({ type: "wallet_topup", orderType: "data", userId: "u1" })).toEqual({ ok: true })
  })

  it("refuses orderType dealer_upgrade without the matching type (it skipped every upgrade check)", () => {
    expect(checkUpgradeInitRequest({ orderType: "dealer_upgrade", planId: PLAN, userId: "u1" })).toMatchObject({ ok: false, status: 400 })
    expect(checkUpgradeInitRequest({ orderType: "dealer_upgrade", planId: PLAN, orderId: "o1", userId: "u1" })).toMatchObject({ ok: false, status: 400 })
  })

  it("refuses a planId that isn't a single UUID string", () => {
    expect(checkUpgradeInitRequest({ ...valid, planId: [PLAN] })).toMatchObject({ ok: false, status: 400 })
    expect(checkUpgradeInitRequest({ ...valid, planId: { id: PLAN } })).toMatchObject({ ok: false, status: 400 })
    expect(checkUpgradeInitRequest({ ...valid, planId: "plan1" })).toMatchObject({ ok: false, status: 400 })
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
