import { describe, expect, it } from "vitest"
import { buildApprovalLink, parseApprovalContact, resolveContact } from "./approval-contact"

describe("parseApprovalContact", () => {
  it.each([
    "0559919037",
    "+233 55 991 9037",
    "233559919037",
    "(055) 991-9037",
    "https://wa.me/233559919037",
    "https://wa.me/233559919037/",
    "https://wa.me/233559919037?text=hi",
    "https://api.whatsapp.com/send?phone=233559919037",
    "https://api.whatsapp.com/send?phone=+233559919037&text=hi",
    "https://api.whatsapp.com/send?phone=%2B233559919037",
  ])("accepts %s", (v) => {
    expect(parseApprovalContact(v)).toEqual({ ok: true, digits: "233559919037" })
  })

  it("treats blank as unset", () => {
    expect(parseApprovalContact("")).toEqual({ ok: true, digits: null })
    expect(parseApprovalContact("   ")).toEqual({ ok: true, digits: null })
    expect(parseApprovalContact(null)).toEqual({ ok: true, digits: null })
    expect(parseApprovalContact(undefined)).toEqual({ ok: true, digits: null })
  })

  it.each([
    "https://wa.me/message/ABC",
    "https://chat.whatsapp.com/x",
    "https://wa.me.evil.com/233559919037",
    "https://wa.me@evil.com/233559919037",
    "https://user:pw@wa.me/233559919037",
    "https://wa.me:8443/233559919037",
    "https://evil.com/?u=https://wa.me/233559919037",
    "javascript:alert(1)",
    "http://wa.me/233559919037",
    "12345",
    "call 0559919037 now",
    "0559919037 and 0244000000",
    "055+9919037",
    7,
    {},
    ["0559919037"],
  ])("rejects %s", (v) => {
    const r = parseApprovalContact(v)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(10)
  })

  it("keeps a foreign number with + as international, not Ghana", () => {
    expect(parseApprovalContact("+20 123 4567")).toEqual({ ok: true, digits: "201234567" })
    expect(parseApprovalContact("https://wa.me/201234567")).toEqual({ ok: true, digits: "201234567" })
    expect(parseApprovalContact("+44 7700 900123")).toEqual({ ok: true, digits: "447700900123" })
  })

  it("rejects bad international forms", () => {
    expect(parseApprovalContact("+0123456789").ok).toBe(false)
    expect(parseApprovalContact("+1234567").ok).toBe(false) // 7 digits
    expect(parseApprovalContact("+1234567890123456").ok).toBe(false) // 16 digits
    expect(parseApprovalContact("+233 12 345").ok).toBe(false) // bad Ghana
  })
})

describe("resolveContact", () => {
  it("normalises the support number", () => {
    expect(resolveContact(null, "0559919037")).toBe("233559919037")
    expect(resolveContact(null, "233559919037")).toBe("233559919037")
    expect(resolveContact(null, "559919037")).toBe("233559919037")
  })
  it("accepts international support digits", () => {
    expect(resolveContact(null, "447700900123")).toBe("447700900123")
  })
  it("returns null when nothing usable", () => {
    expect(resolveContact(null, null)).toBeNull()
    expect(resolveContact("", "")).toBeNull()
    expect(resolveContact(null, "12345")).toBeNull()
    expect(resolveContact(null, "abc")).toBeNull()
  })
  it("prefers a valid configured value", () => {
    expect(resolveContact("201234567", "0559919037")).toBe("201234567")
  })
  it("falls back when configured is invalid", () => {
    expect(resolveContact("abc", "0559919037")).toBe("233559919037")
  })
})

describe("buildApprovalLink", () => {
  it("builds a wa.me link that round-trips the text", () => {
    const url = new URL(buildApprovalLink("233559919037", { code: "API-7K3Q9M", email: "a+b&c#d@x.com" }))
    expect(url.origin + url.pathname).toBe("https://wa.me/233559919037")
    expect(url.searchParams.get("text")).toBe(
      "Hello, I've requested Datagod API approval. Code: API-7K3Q9M. Account: a+b&c#d@x.com.",
    )
  })
  it("uses %20 for spaces", () => {
    expect(buildApprovalLink("233559919037", { code: "API-7K3Q9M", email: null })).not.toContain("+")
  })
  it("omits the account for null or blank email", () => {
    const expected = "Hello, I've requested Datagod API approval. Code: API-7K3Q9M."
    for (const email of [null, "", "  "]) {
      const url = new URL(buildApprovalLink("233559919037", { code: "API-7K3Q9M", email }))
      expect(url.searchParams.get("text")).toBe(expected)
    }
  })
  it("round-trips an email with < and a newline", () => {
    const email = "a<b>@x.com\nline2"
    const url = new URL(buildApprovalLink("233559919037", { code: "API-7K3Q9M", email }))
    expect(url.searchParams.get("text")).toContain(`Account: ${email}.`)
  })
  it("cannot be steered to another host", () => {
    for (const bad of ["evil.com/x", "233559919037@evil.com", "233 559919037", "", "+233559919037", "1234567"]) {
      expect(() => buildApprovalLink(bad, { code: "API-7K3Q9M", email: null })).toThrow()
    }
  })
})
