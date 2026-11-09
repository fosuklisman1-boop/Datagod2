// The Hubtel payer rule on WhatsApp (isUssdHubtelPayer with the sender as owner): only the sender's own number. No
// other number qualifies, verified or not (security ruling: isPhoneOtpVerified isn't bound to the requester).
import { describe, expect, it, vi } from "vitest"

const otp = vi.hoisted(() => ({ isPhoneOtpVerified: vi.fn(async () => true) }))
vi.mock("@/lib/storefront-otp", () => otp)

import { isUssdHubtelPayer } from "./gateway-charge"

const SENDER = "233244123456"

describe("isUssdHubtelPayer on WhatsApp (owner = sender)", () => {
  it("the sender's own number, in any form, is a Hubtel payer", () => {
    expect(isUssdHubtelPayer({ chargePhone: "0244123456", ownerPhone: SENDER, provider: "mtn" })).toBe(true)
    expect(isUssdHubtelPayer({ chargePhone: "+233244123456", ownerPhone: SENDER, provider: "mtn" })).toBe(true)
  })

  it("any other number is not, even one an OTP lookup would call verified; no lookup is made", () => {
    expect(isUssdHubtelPayer({ chargePhone: "0551234567", ownerPhone: SENDER, provider: "mtn" })).toBe(false)
    expect(otp.isPhoneOtpVerified).not.toHaveBeenCalled()
  })

  it("the provider must be the sender's own network", () => {
    expect(isUssdHubtelPayer({ chargePhone: "0244123456", ownerPhone: SENDER, provider: "vod" })).toBe(false)
  })

  it("an unsendable form or no number is not", () => {
    expect(isUssdHubtelPayer({ chargePhone: "244123456", ownerPhone: SENDER, provider: "mtn" })).toBe(false)
    expect(isUssdHubtelPayer({ chargePhone: undefined, ownerPhone: SENDER, provider: "mtn" })).toBe(false)
  })
})
