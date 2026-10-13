import { describe, expect, it } from "vitest"
import { REVIEW_ALERT_DEBOUNCE_MS, reviewAlertText } from "./review-alert"
import { makeTx } from "./testing/fixtures"

describe("review alert", () => {
  it("debounces 15 minutes", () => { expect(REVIEW_ALERT_DEBOUNCE_MS).toBe(15 * 60_000) })
  it("names the reference, service, amount and reason, and where to act", () => {
    const t = reviewAlertText(makeTx({ client_reference: "HCS-airtime_mtn-abc", service_key: "airtime_mtn", amount: 5, review_reason: "No response from Hubtel" }))
    expect(t.subject).toMatch(/review/i)
    expect(t.message).toContain("HCS-airtime_mtn-abc")
    expect(t.message).toContain("airtime_mtn")
    expect(t.message).toContain("GHS 5.00")
    expect(t.message).toContain("No response from Hubtel")
    expect(t.message).toContain("/admin/hubtel-commission")
  })
  it("includes the order and destination when present", () => {
    const t = reviewAlertText(makeTx({ destination: "0241234567", order_table: "airtime_orders", order_id: "ord-9" }))
    expect(t.message).toContain("0241234567")
    expect(t.message).toContain("airtime_orders/ord-9")
  })
  it("omits the order part when there is no linked order", () => {
    const t = reviewAlertText(makeTx({ order_table: null, order_id: null }))
    expect(t.message).not.toMatch(/order /)
  })
})
