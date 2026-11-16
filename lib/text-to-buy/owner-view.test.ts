import { describe, it, expect } from "vitest"
import { deriveOwnerStatus, maskPhone, buildOwnerView, orderStatusLabel, type OwnerRaw } from "./owner-view"

const NOW = new Date("2026-11-16T12:00:00Z")
const ok = (over: Partial<OwnerRaw> = {}): OwnerRaw => ({
  shopEnabled: true,
  shopNumber: "0559919037",
  shop: { name: "Datago", isActive: true, isBlocked: false },
  code: { code: "8468", status: "active" },
  account: { status: "active", balance: 50 },
  orders: [],
  windowOrders: [],
  credits30d: 0,
  ...over,
})

describe("maskPhone", () => {
  it("keeps the first 3 and last 3 digits", () => expect(maskPhone("0241234567")).toBe("024••••567"))
  it("hides anything that is not a 10-digit number", () => expect(maskPhone("abc")).toBe("•••"))
})

describe("deriveOwnerStatus", () => {
  it("off when the shop line switch is off, whatever else is true", () => {
    expect(deriveOwnerStatus(ok({ shopEnabled: false }))).toBe("off")
  })
  it("closed for a blocked, inactive or non-active-code shop", () => {
    expect(deriveOwnerStatus(ok({ shop: { name: "x", isActive: true, isBlocked: true } }))).toBe("closed")
    expect(deriveOwnerStatus(ok({ shop: { name: "x", isActive: false, isBlocked: false } }))).toBe("closed")
    expect(deriveOwnerStatus(ok({ code: { code: "8468", status: "suspended" } }))).toBe("closed")
  })
  it("closed when the shop has no code yet", () => expect(deriveOwnerStatus(ok({ code: null }))).toBe("closed"))
  it("no_sms when there is no SMS account or it is not active", () => {
    expect(deriveOwnerStatus(ok({ account: null }))).toBe("no_sms")
    expect(deriveOwnerStatus(ok({ account: { status: "inactive", balance: 99 } }))).toBe("no_sms")
    expect(deriveOwnerStatus(ok({ account: { status: "suspended", balance: 99 } }))).toBe("no_sms")
  })
  it("paused below 2 credits (the smallest order reserve), low below 10, live otherwise", () => {
    expect(deriveOwnerStatus(ok({ account: { status: "active", balance: 1 } }))).toBe("paused")
    expect(deriveOwnerStatus(ok({ account: { status: "active", balance: 2 } }))).toBe("low")
    expect(deriveOwnerStatus(ok({ account: { status: "active", balance: 9 } }))).toBe("low")
    expect(deriveOwnerStatus(ok({ account: { status: "active", balance: 10 } }))).toBe("live")
  })
})

describe("orderStatusLabel", () => {
  it("maps the order's timestamps and state", () => {
    expect(orderStatusLabel({ state: "awaiting_payment", paid_at: null, delivered_at: null })).toBe("Waiting for payment")
    expect(orderStatusLabel({ state: "paid", paid_at: "2026-11-16T10:00:00Z", delivered_at: null })).toBe("Paid, delivering")
    expect(orderStatusLabel({ state: "closed", paid_at: "2026-11-16T10:00:00Z", delivered_at: "2026-11-16T10:05:00Z" })).toBe("Delivered")
    expect(orderStatusLabel({ state: "closed", paid_at: "2026-11-16T10:00:00Z", delivered_at: null })).toBe("Paid, needs review")
    expect(orderStatusLabel({ state: "closed", paid_at: null, delivered_at: null })).toBe("Not paid")
  })
})

describe("buildOwnerView", () => {
  it("never exposes the sender and masks the recipient", () => {
    const v = buildOwnerView(
      ok({
        orders: [{ id: "o1", size: "5GB", recipient: "0241234567", gift: true, amount: 22.5, state: "closed", created_at: "2026-11-16T10:00:00Z", paid_at: "2026-11-16T10:01:00Z", delivered_at: "2026-11-16T10:03:00Z" }],
      }),
      NOW,
    )
    expect(v.orders).toHaveLength(1)
    expect(v.orders[0]).toMatchObject({ id: "o1", size: "5GB", recipient: "024••••567", gift: true, amount: 22.5, status: "Delivered" })
    expect(JSON.stringify(v)).not.toContain("0241234567")
  })

  it("counts the 30-day window: texts that became orders, paid, delivered, and the credits used", () => {
    const v = buildOwnerView(
      ok({
        credits30d: 14,
        windowOrders: [
          { paid_at: null, delivered_at: null },
          { paid_at: "2026-11-10T00:00:00Z", delivered_at: null },
          { paid_at: "2026-11-11T00:00:00Z", delivered_at: "2026-11-11T00:05:00Z" },
        ],
      }),
      NOW,
    )
    expect(v.stats).toEqual({ orders: 3, paid: 2, delivered: 1, creditsUsed: 14 })
  })

  it("carries the shop code and number for the how-to-share block, and tells a customer what to text", () => {
    const v = buildOwnerView(ok(), NOW)
    expect(v.shopNumber).toBe("0559919037")
    expect(v.shopCode).toBe("8468")
    expect(v.shareMessage).toContain("0559919037")
    expect(v.shareMessage).toContain("8468")
    expect(v.shareMessage).toContain("Datago")
  })

  it("has no share message while the line is off or the shop has no code", () => {
    expect(buildOwnerView(ok({ shopEnabled: false }), NOW).shareMessage).toBeNull()
    expect(buildOwnerView(ok({ code: null }), NOW).shareMessage).toBeNull()
    expect(buildOwnerView(ok({ shopNumber: "" }), NOW).shareMessage).toBeNull()
  })

  it("reports the balance only when there is an account", () => {
    expect(buildOwnerView(ok(), NOW).balance).toBe(50)
    expect(buildOwnerView(ok({ account: null }), NOW).balance).toBeNull()
  })
})
