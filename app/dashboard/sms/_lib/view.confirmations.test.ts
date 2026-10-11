import { describe, it, expect } from "vitest"
import { ORDER_CONFIRMATION_HELP, confirmationToggleState, isOrderConfirmation } from "./view"

describe("confirmationToggleState", () => {
  it("is disabled and unchecked while loading", () => {
    expect(confirmationToggleState(null, false)).toEqual({ checked: false, disabled: true, reason: null })
  })
  it("enabled when it can be enabled", () => {
    expect(confirmationToggleState({ useOwnSender: false, canEnable: true }, false)).toEqual({ checked: false, disabled: false, reason: null })
  })
  it("disabled with the reason when it can't be enabled", () => {
    expect(confirmationToggleState({ useOwnSender: false, canEnable: false, reason: "Need a sender ID" }, false))
      .toEqual({ checked: false, disabled: true, reason: "Need a sender ID" })
  })
  it("falls back to a generic reason", () => {
    expect(confirmationToggleState({ useOwnSender: false, canEnable: false }, false).reason).toBe("Not available yet.")
  })
  it("lets a shop that lost eligibility switch OFF", () => {
    expect(confirmationToggleState({ useOwnSender: true, canEnable: false, reason: "x" }, false))
      .toEqual({ checked: true, disabled: false, reason: null })
  })
  it("is disabled while saving", () => {
    expect(confirmationToggleState({ useOwnSender: true, canEnable: true }, true).disabled).toBe(true)
  })
})

describe("copy + tag", () => {
  it("helper text is the agreed wording", () => {
    expect(ORDER_CONFIRMATION_HELP).toBe("Customers get your order confirmation from your own sender ID. Costs 1 credit per message segment.")
  })
  it("isOrderConfirmation only matches source order_confirmation", () => {
    expect(isOrderConfirmation({ source: "order_confirmation" })).toBe(true)
    expect(isOrderConfirmation({ source: null })).toBe(false)
    expect(isOrderConfirmation({})).toBe(false)
  })
})
