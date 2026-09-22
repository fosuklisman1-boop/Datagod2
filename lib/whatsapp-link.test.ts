import { normalizeWhatsAppLink } from "@/lib/whatsapp-link"

describe("normalizeWhatsAppLink", () => {
  it("returns null for empty/missing input", () => {
    expect(normalizeWhatsAppLink(null)).toBeNull()
    expect(normalizeWhatsAppLink(undefined)).toBeNull()
    expect(normalizeWhatsAppLink("")).toBeNull()
    expect(normalizeWhatsAppLink("   ")).toBeNull()
  })

  it("leaves an already well-formed absolute URL unchanged", () => {
    expect(normalizeWhatsAppLink("https://wa.me/233551678899")).toBe("https://wa.me/233551678899")
    expect(normalizeWhatsAppLink("https://wa.me/message/AOOIOIJ3PLMEG1")).toBe("https://wa.me/message/AOOIOIJ3PLMEG1")
    expect(normalizeWhatsAppLink("https://wa.link/kqkdep")).toBe("https://wa.link/kqkdep")
    expect(normalizeWhatsAppLink("https://wa.me/qr/6VQCDAVKZJ55G1")).toBe("https://wa.me/qr/6VQCDAVKZJ55G1")
    expect(normalizeWhatsAppLink("https://chat.whatsapp.com/DBzZqZ5wwRNCycJruqw02z")).toBe(
      "https://chat.whatsapp.com/DBzZqZ5wwRNCycJruqw02z"
    )
  })

  it("converts a bare Ghana phone number to a proper wa.me link", () => {
    expect(normalizeWhatsAppLink("0598781315")).toBe("https://wa.me/233598781315")
    expect(normalizeWhatsAppLink("0542404550")).toBe("https://wa.me/233542404550")
  })

  it("repairs real malformed values observed in production", () => {
    expect(normalizeWhatsAppLink("https:/wa.me/0534777831")).toBe("https://wa.me/233534777831")
    expect(normalizeWhatsAppLink("https.wa.me 0249489229")).toBe("https://wa.me/233249489229")
    expect(normalizeWhatsAppLink("https//wa.me+233538889045")).toBe("https://wa.me/233538889045")
    expect(normalizeWhatsAppLink("Wa.me/+233531702460")).toBe("https://wa.me/233531702460")
  })

  it("falls back to prefixing https:// for anything else unrecognized, so it is never a relative path", () => {
    expect(normalizeWhatsAppLink("some-random-text")).toBe("https://some-random-text")
  })
})
