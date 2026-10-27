import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { parseUssdCodes, validateUssdCodesInput, readPublicUssdCodes, getPublicUssdCodes } from "./ussd-codes"

function fakeDb(result: { data: unknown; error: unknown }): SupabaseClient {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => result }
  return { from: () => chain } as unknown as SupabaseClient
}

describe("readPublicUssdCodes", () => {
  it("returns parsed codes on success", async () => {
    const db = fakeDb({ data: { value: '{"main":"*920#","shop":null}' }, error: null })
    expect(await readPublicUssdCodes(db)).toEqual({ main: "*920#", shop: null })
  })
  it("throws on a DB error (so the admin GET can 500)", async () => {
    const db = fakeDb({ data: null, error: { message: "boom" } })
    await expect(readPublicUssdCodes(db)).rejects.toBeTruthy()
  })
  it("getPublicUssdCodes still swallows errors to nulls", async () => {
    const db = fakeDb({ data: null, error: { message: "boom" } })
    expect(await getPublicUssdCodes(db)).toEqual({ main: null, shop: null })
  })
})

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
