import { describe, it, expect } from "vitest"
import {
  senderStatus, senderLimit, openSenderCount, senderRequestBlock, formatSenderInput, checkSenderInput,
  kycFormFromProfile, kycPayload, kycFieldErrors, kycSubmitGaps, checkKycFile, kycEditable, kycSteps, cardEnding, EMPTY_KYC_FORM,
  type KycProfileView,
} from "./view"

const profile = (o: Partial<KycProfileView> = {}): KycProfileView => ({
  status: "draft", business_name: "Kings Data", description: "We sell data bundles", website: null, whatsapp_number: "233241234567",
  ghana_card_last4: "1234", has_ghana_card_doc: true, has_registration_doc: false, ...o,
})

describe("sender helpers", () => {
  it("status meta incl. paused/revoked and unknown", () => {
    expect(senderStatus("paused").label).toBe("Paused")
    expect(senderStatus("revoked").tone).toBe("danger")
    expect(senderStatus("weird")).toEqual({ label: "weird", tone: "muted" })
  })
  it("limits and open count", () => {
    expect(senderLimit("platform")).toBe(1)
    expect(senderLimit("business")).toBe(200)
    expect(openSenderCount([{ local_status: "pending" }, { local_status: "rejected" }, { local_status: "paused" }, { local_status: "revoked" }])).toBe(2)
  })
  it("request block explains the platform limit", () => {
    expect(senderRequestBlock("platform", [])).toBeNull()
    expect(senderRequestBlock("platform", [{ local_status: "active" }])).toMatch(/one free sender ID/)
    expect(senderRequestBlock("platform", [{ local_status: "rejected" }])).toBeNull()
    expect(senderRequestBlock("business", [{ local_status: "active" }])).toBeNull()
    expect(senderRequestBlock("business", Array(200).fill({ local_status: "active" }))).toMatch(/200/)
  })
  it("formatSenderInput uppercases, strips symbols, caps at 11", () => {
    expect(formatSenderInput("kft shop!")).toBe("KFT SHOP")
    expect(formatSenderInput("abcdefghijklmnop")).toBe("ABCDEFGHIJK")
  })
  it("checkSenderInput applies the server format rules", () => {
    expect(checkSenderInput("ab").ok).toBe(false)
    expect(checkSenderInput("123").ok).toBe(false)
    expect(checkSenderInput("kft shop")).toEqual({ ok: true, name: "KFT SHOP" })
  })
})

describe("kyc helpers", () => {
  it("prefills from profile with blank card number", () => {
    const f = kycFormFromProfile(profile())
    expect(f.business_name).toBe("Kings Data")
    expect(f.ghana_card_number).toBe("")
    expect(kycFormFromProfile(null)).toEqual(EMPTY_KYC_FORM)
  })
  it("cardEnding", () => {
    expect(cardEnding("1234")).toBe("ID ending 1234")
    expect(cardEnding(null)).toBeNull()
  })
  it("payload omits empty fields except website", () => {
    expect(kycPayload({ ...EMPTY_KYC_FORM, business_name: "Ab" })).toEqual({ website: "", business_name: "Ab" })
  })
  it("field errors only for typed content", () => {
    expect(kycFieldErrors(EMPTY_KYC_FORM)).toEqual({})
    const e = kycFieldErrors({ business_name: "A", description: "short", website: "", whatsapp_number: "12", ghana_card_number: "GHA-1-1" })
    expect(Object.keys(e).sort()).toEqual(["business_name", "description", "ghana_card_number", "whatsapp_number"])
    expect(kycFieldErrors({ ...EMPTY_KYC_FORM, ghana_card_number: "gha-123456789-0" })).toEqual({})
  })
  it("submit gaps honour saved card and doc", () => {
    expect(kycSubmitGaps(EMPTY_KYC_FORM, null)).toEqual(["Business name", "Description", "WhatsApp number", "Ghana Card number", "Ghana Card photo"])
    expect(kycSubmitGaps(kycFormFromProfile(profile()), profile())).toEqual([])
    expect(kycSubmitGaps(kycFormFromProfile(profile()), profile({ has_ghana_card_doc: false }))).toEqual(["Ghana Card photo"])
  })
  it("file check", () => {
    expect(checkKycFile({ type: "image/png", size: 1000 })).toBeNull()
    expect(checkKycFile({ type: "text/plain", size: 1000 })).toMatch(/JPG/)
    expect(checkKycFile({ type: "image/png", size: 5 * 1024 * 1024 })).toMatch(/4 MB/)
  })
  it("editable states", () => {
    expect(kycEditable(null)).toBe(true)
    expect(kycEditable("rejected")).toBe(true)
    expect(kycEditable("submitted")).toBe(false)
    expect(kycEditable("approved")).toBe(false)
  })
  it("stepper progression", () => {
    const st = (s: Parameters<typeof kycSteps>[0], a = false) => kycSteps(s, a).map((x) => x.state).join(",")
    expect(st(null)).toBe("current,todo,todo,todo")
    expect(st("draft")).toBe("current,todo,todo,todo")
    expect(st("submitted")).toBe("done,current,todo,todo")
    expect(st("approved")).toBe("done,done,done,current")
    expect(st("approved", true)).toBe("done,done,done,done")
    expect(st("rejected")).toBe("error,todo,todo,todo")
  })
})
