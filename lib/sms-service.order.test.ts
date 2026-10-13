import { describe, it, expect, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { buildProviderOrder } from "./sms-service"
import { CATEGORY_DEFAULTS, type SmsCategory, type CategoryProvider } from "./sms/categories"

function routing(over: Partial<Record<SmsCategory, CategoryProvider>> = {}, primary = "hubtel", fallbacks: string[] = ["moolre"]) {
  return {
    primary,
    fallbacks,
    categoryProviders: { ...Object.fromEntries(Object.keys(CATEGORY_DEFAULTS).map((k) => [k, "global"])), ...over } as Record<SmsCategory, CategoryProvider>,
    tenantProviderChoice: false,
  }
}

const base = { breakerOpen: false, fallbackProvider: "moolre", otpEnvProvider: undefined as string | undefined }

describe("buildProviderOrder", () => {
  it("global selector keeps [primary, ...fallbacks]", () => {
    const o = buildProviderOrder({ ...base, payload: { phone: "1", message: "m", type: "order_confirmed" }, routing: routing(), isOtp: false })
    expect(o).toEqual(["hubtel", "moolre"])
  })

  it("category selector leads, then rest de-duped", () => {
    const o = buildProviderOrder({ ...base, payload: { phone: "1", message: "m", type: "wallet_topup_success" }, routing: routing({ payments_wallet: "moolre" }), isOtp: false })
    expect(o).toEqual(["moolre", "hubtel"])
  })

  it("payload.provider overrides the category selector", () => {
    const o = buildProviderOrder({ ...base, payload: { phone: "1", message: "m", type: "wallet_topup_success", provider: "hubtel" }, routing: routing({ payments_wallet: "moolre" }, "moolre", ["hubtel"]), isOtp: false })
    expect(o[0]).toBe("hubtel")
  })

  it("OTP: selector leads when breaker closed", () => {
    const o = buildProviderOrder({ ...base, payload: { phone: "1", message: "m", type: "phone_otp" }, routing: routing({ otp: "hubtel" }, "moolre", ["mnotify"]), isOtp: true, fallbackProvider: "mnotify" })
    expect(o[0]).toBe("hubtel")
  })

  it("OTP: open breaker forces fallback first, selector ignored", () => {
    const o = buildProviderOrder({ ...base, payload: { phone: "1", message: "m", type: "phone_otp" }, routing: routing({ otp: "hubtel" }, "moolre", ["mnotify"]), isOtp: true, breakerOpen: true, fallbackProvider: "mnotify" })
    expect(o[0]).toBe("mnotify")
  })

  it("OTP: global selector uses SMS_OTP_PROVIDER", () => {
    const o = buildProviderOrder({ ...base, payload: { phone: "1", message: "m", type: "phone_otp" }, routing: routing({}, "hubtel", ["mnotify"]), isOtp: true, fallbackProvider: "mnotify", otpEnvProvider: "moolre" })
    expect(o).toEqual(["moolre", "mnotify", "hubtel"])
  })

  it("OTP: payload.provider is ignored (warns)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const o = buildProviderOrder({ ...base, payload: { phone: "1", message: "m", type: "phone_otp", provider: "hubtel" }, routing: routing({}, "moolre", ["mnotify"]), isOtp: true, fallbackProvider: "mnotify" })
    expect(o[0]).toBe("moolre")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("unknown type follows the system selector", () => {
    const o = buildProviderOrder({ ...base, payload: { phone: "1", message: "m", type: "totally_unknown" }, routing: routing({ system: "moolre" }), isOtp: false })
    expect(o).toEqual(["moolre", "hubtel"])
  })

  it("custom sender: forced moolre lead becomes hubtel when Hubtel is configured", () => {
    const o = buildProviderOrder({ ...base, payload: { phone: "1", message: "m", type: "wallet_topup_success", provider: "moolre", senderId: "KINGS" }, routing: routing({}, "moolre", ["hubtel"]), isOtp: false, hubtelConfigured: true })
    expect(o[0]).toBe("hubtel")
  })
  it("custom sender: category moolre lead becomes hubtel; unconfigured Hubtel or platform sender unaffected", () => {
    const r = routing({ payments_wallet: "moolre" }, "hubtel", [])
    const p = { phone: "1", message: "m", type: "wallet_topup_success" }
    expect(buildProviderOrder({ ...base, payload: { ...p, senderId: "KINGS" }, routing: r, isOtp: false, hubtelConfigured: true })[0]).toBe("hubtel")
    expect(buildProviderOrder({ ...base, payload: { ...p, senderId: "KINGS" }, routing: r, isOtp: false, hubtelConfigured: false })[0]).toBe("moolre")
    expect(buildProviderOrder({ ...base, payload: p, routing: r, isOtp: false, hubtelConfigured: true })[0]).toBe("moolre")
  })
})
