import { describe, it, expect } from "vitest"
import { botBillerAllowed } from "@/lib/bot-commission/context"
import { isValidBillAccount, isValidBillEmail, normaliseInputs } from "@/lib/bills/billers"
import { UZO_PROFILE, WHATSAPP_PROFILE } from "./profile"
import { uzoSafeLabel } from "./screen"
import { ascii, flowProfile, botFlowContext, parsePayPhone, waPromptSentText, liveUzoBotIo, type BotFlowCtx } from "./kit"

const SHOP = "11111111-2222-4333-8444-555555555555"

describe("presentation profiles", () => {
  it("uzo: 160 chars, 5 per page, the Plan 3 label (uzoSafeLabel + ASCII), no pay phone, no Ghana Water", () => {
    expect(UZO_PROFILE).toMatchObject({ kind: "uzo", limit: 160, pageSize: 5, askPayPhone: false, allowGhanaWater: false })
    for (const s of ["Data 1GB Bundle", "Café Bundles", "  x  ", ""]) expect(UZO_PROFILE.label(s)).toBe(ascii(uzoSafeLabel(s)))
  })

  it("whatsapp: 1000 chars, 10 per page, names as sent (trimmed, whitespace collapsed), pay phone, Ghana Water", () => {
    expect(WHATSAPP_PROFILE).toMatchObject({ kind: "whatsapp", limit: 1000, pageSize: 10, askPayPhone: true, allowGhanaWater: true })
    expect(WHATSAPP_PROFILE.label("Data 1GB Bundle")).toBe("Data 1GB Bundle")
    expect(WHATSAPP_PROFILE.label("  Café   Data\nBundle ")).toBe("Café Data Bundle")
  })

  it("the profile follows the surface; a mismatching one fails closed (no engine context)", () => {
    const base: BotFlowCtx = { surface: "ussd", sessionId: "s", dialingPhone: "0244123456", shopId: null }
    expect(flowProfile(base)).toBe(UZO_PROFILE)
    expect(flowProfile({ ...base, surface: "whatsapp" })).toBe(WHATSAPP_PROFILE)
    expect(flowProfile({ ...base, profile: WHATSAPP_PROFILE })).toBeNull()
    expect(botFlowContext({ ...base, profile: WHATSAPP_PROFILE })).toBeNull()
    expect(flowProfile({ ...base, surface: "whatsapp_shop", profile: UZO_PROFILE })).toBeNull()
  })

  it("engine context on WhatsApp: main => no shop; shop => the shop, null without one", () => {
    const wa: BotFlowCtx = { surface: "whatsapp", sessionId: "s", dialingPhone: "233244123456", shopId: SHOP }
    expect(botFlowContext(wa)).toEqual({ botSurface: "whatsapp", shopId: null, rail: "paystack", buyerPhone: "233244123456" })
    expect(botFlowContext({ ...wa, surface: "whatsapp_shop" })).toEqual({ botSurface: "whatsapp_shop", shopId: SHOP, rail: "paystack", buyerPhone: "233244123456" })
    expect(botFlowContext({ ...wa, surface: "whatsapp_shop", shopId: null })).toBeNull()
  })

  it("WhatsApp has no live io here (the adapter injects one)", () => {
    expect(() => liveUzoBotIo("whatsapp")).toThrow()
    expect(() => liveUzoBotIo("whatsapp_shop")).toThrow()
  })
})

describe("pay phone + prompt text", () => {
  it("parses Ghana mobiles to local form; anything else is null", () => {
    expect(parsePayPhone("055 123 4567")).toBe("0551234567")
    expect(parsePayPhone("+233244123456")).toBe("0244123456")
    // The shared validator (isValidGhanaMobile); the engine still refuses a number with no MoMo provider (NO_PROVIDER).
    for (const bad of ["123", "02441234567", "", "abc", "+44 7700 900123"]) expect(parsePayPhone(bad)).toBeNull()
  })

  it("prompt-sent names the number actually prompted, or none", () => {
    expect(waPromptSentText("233201234567")).toBe("MoMo prompt sent to 0201234567. Approve it on your phone to complete.\n\nReceived an OTP instead? Reply here with the code.")
    expect(waPromptSentText(null)).toBe("MoMo prompt sent. Approve it on your phone to complete.\n\nReceived an OTP instead? Reply here with the code.")
  })
})

describe("engine Ghana Water rule", () => {
  it("refused on every USSD surface, allowed on both WhatsApp bots", () => {
    for (const s of ["ussd", "ussd_shop", "hubtel_ussd"] as const) expect(botBillerAllowed(s, "ghana_water")).toBe(false)
    for (const s of ["whatsapp", "whatsapp_shop"] as const) expect(botBillerAllowed(s, "ghana_water")).toBe(true)
    expect(botBillerAllowed("ussd", "ecg")).toBe(true)
  })

  it("isValidBillEmail is exactly normaliseInputs' Ghana Water email rule", () => {
    for (const e of ["a@b.co", " a@b.co ", "x.y@mail.example.com", "bad", "a@b", "a b@c.d", "", "@b.co"]) {
      const n = normaliseInputs("ghana_water", { account: "12345678", phone: "0244123456", email: e })
      expect(isValidBillEmail(e)).toBe(n.ok)
    }
  })

  it("isValidBillAccount is exactly normaliseInputs' account rule", () => {
    for (const a of ["12345678", "70 1234 5678", "P-1234", "abc", "#!", "", "A".repeat(30), "A".repeat(31)]) {
      expect(isValidBillAccount(a)).toBe(normaliseInputs("dstv", { account: a }).ok)
    }
  })
})
