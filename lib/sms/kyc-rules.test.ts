import { describe, it, expect } from "vitest"
import { validateKycDraft, missingForSubmit, nextKycStatus, docExtension, matchesDocSignature, KYC_DOC_MAX_BYTES } from "./kyc-rules"

describe("validateKycDraft", () => {
  it("accepts a full draft, keeps only the card's last 4, normalises phone + website", () => {
    const r = validateKycDraft({
      business_name: "  Kings Data  ", description: "We sell data bundles in Kumasi", website: "kingsdata.com",
      whatsapp_number: "024 123 4567", ghana_card_number: "gha-123456789-0",
    })
    expect(r).toEqual({ ok: true, patch: {
      business_name: "Kings Data", description: "We sell data bundles in Kumasi", website: "https://kingsdata.com",
      whatsapp_number: "233241234567", ghana_card_last4: "7890",
    } })
  })
  it("never puts the full card number in the patch", () => {
    const r = validateKycDraft({ ghana_card_number: "GHA-123456789-0" })
    expect(JSON.stringify(r)).not.toContain("123456789")
  })
  it("only includes fields that were sent", () => {
    expect(validateKycDraft({ business_name: "Ab" })).toEqual({ ok: true, patch: { business_name: "Ab" } })
  })
  it("reports every invalid field", () => {
    const r = validateKycDraft({ business_name: "A", description: "short", website: "not a site", whatsapp_number: "123", ghana_card_number: "GHA-12-3" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["business_name", "description", "ghana_card_number", "website", "whatsapp_number"])
  })
})

describe("missingForSubmit", () => {
  const full = { business_name: "Kings", description: "We sell data bundles", whatsapp_number: "233241234567", ghana_card_last4: "7890", ghana_card_doc_path: "a/b.jpg" }
  it("nothing missing", () => expect(missingForSubmit(full)).toEqual([]))
  it("lists missing fields", () => expect(missingForSubmit({ ...full, ghana_card_doc_path: null, description: null }))
    .toEqual(["description", "ghana_card_doc_path"]))
})

describe("nextKycStatus", () => {
  it("save", () => {
    expect(nextKycStatus(null, "save")).toBe("draft")
    expect(nextKycStatus("draft", "save")).toBe("draft")
    expect(nextKycStatus("rejected", "save")).toBe("draft")
    expect(nextKycStatus("submitted", "save")).toBeNull()
    expect(nextKycStatus("approved", "save")).toBeNull()
  })
  it("submit/approve/reject", () => {
    expect(nextKycStatus("draft", "submit")).toBe("submitted")
    expect(nextKycStatus("rejected", "submit")).toBeNull()
    expect(nextKycStatus("submitted", "approve")).toBe("approved")
    expect(nextKycStatus("submitted", "reject")).toBe("rejected")
    expect(nextKycStatus("draft", "approve")).toBeNull()
  })
})

describe("docExtension", () => {
  it("accepts images and PDFs up to 4 MB", () => {
    expect(docExtension("image/jpeg", 1000)).toEqual({ ok: true, ext: "jpg" })
    expect(docExtension("application/pdf", KYC_DOC_MAX_BYTES)).toEqual({ ok: true, ext: "pdf" })
  })
  it("rejects other types, empty and oversize files", () => {
    expect(docExtension("image/gif", 10).ok).toBe(false)
    expect(docExtension("image/png", 0).ok).toBe(false)
    expect(docExtension("image/png", KYC_DOC_MAX_BYTES + 1).ok).toBe(false)
  })
})

describe("matchesDocSignature", () => {
  const b = (...n: number[]) => new Uint8Array([...n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  it("matches real signatures", () => {
    expect(matchesDocSignature("image/jpeg", b(0xff, 0xd8, 0xff))).toBe(true)
    expect(matchesDocSignature("image/png", b(0x89, 0x50, 0x4e, 0x47))).toBe(true)
    expect(matchesDocSignature("application/pdf", b(0x25, 0x50, 0x44, 0x46))).toBe(true)
    expect(matchesDocSignature("image/webp", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(true)
  })
  it("rejects a mislabelled file", () => {
    expect(matchesDocSignature("image/png", b(0x25, 0x50, 0x44, 0x46))).toBe(false)
    expect(matchesDocSignature("application/pdf", b(0x4d, 0x5a))).toBe(false)
  })
})
