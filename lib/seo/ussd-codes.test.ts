import { describe, it, expect } from "vitest"
import { parseUssdCodes, validateUssdCodesInput } from "./ussd-codes"

const ok = (main: unknown, shop: unknown = "") => validateUssdCodesInput({ main, shop })

describe("validateUssdCodesInput", () => {
  it("accepts simple codes", () => {
    expect(ok("*920#")).toEqual({ ok: true, value: { main: "*920#", shop: null } })
    expect(ok("*920*44#")).toMatchObject({ ok: true })
  })

  it("accepts the SHOPCODE placeholder for shop only", () => {
    expect(validateUssdCodesInput({ main: "", shop: "*920*SHOPCODE#" })).toEqual({
      ok: true,
      value: { main: null, shop: "*920*SHOPCODE#" },
    })
    expect(ok("*920*SHOPCODE#").ok).toBe(false)
  })

  it.each(["*920", "920#", "<script>", "*920#;drop", "*920*" + "1".repeat(34) + "#"])("rejects %s", (bad) => {
    expect(ok(bad).ok).toBe(false)
    expect(validateUssdCodesInput({ main: "", shop: bad }).ok).toBe(false)
  })

  it("empty or missing clears the field", () => {
    expect(validateUssdCodesInput({ main: "  ", shop: undefined })).toEqual({
      ok: true,
      value: { main: null, shop: null },
    })
  })

  it("trims values and rejects non-object bodies", () => {
    expect(ok("  *920#  ")).toEqual({ ok: true, value: { main: "*920#", shop: null } })
    expect(validateUssdCodesInput(null).ok).toBe(false)
    expect(ok(123).ok).toBe(false)
  })
})

describe("parseUssdCodes", () => {
  it("nulls invalid fields", () => {
    expect(parseUssdCodes('{"main":"*920#","shop":"bad"}')).toEqual({ main: "*920#", shop: null })
  })
  it("tolerates null, junk and non-JSON", () => {
    expect(parseUssdCodes(null)).toEqual({ main: null, shop: null })
    expect(parseUssdCodes("not json")).toEqual({ main: null, shop: null })
    expect(parseUssdCodes("[1]")).toEqual({ main: null, shop: null })
  })
  it("rejects a main code with letters", () => {
    expect(parseUssdCodes('{"main":"*920*SHOPCODE#"}').main).toBeNull()
  })
})
