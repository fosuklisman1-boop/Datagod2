import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { parseMainUssdCode, validateUssdCodesInput, readPublicUssdCodes, getPublicUssdCodes } from "./ussd-codes"

type Result = { data: unknown; error: unknown }

/** public_ussd_codes row is read with .eq("key", ...); the singleton settings row with .is("key", null). */
function fakeDb(mainRow: Result, singletonRow: Result = { data: null, error: null }): SupabaseClient {
  return {
    from: () => {
      let singleton = false
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => { singleton = true; return chain },
        limit: () => chain,
        maybeSingle: async () => (singleton ? singletonRow : mainRow),
      }
      return chain
    },
  } as unknown as SupabaseClient
}

describe("readPublicUssdCodes", () => {
  it("reads the main code and the shop dial code from /admin/ussd-shops", async () => {
    const db = fakeDb({ data: { value: '{"main":"*920#"}' }, error: null }, { data: { ussd_shop_dial_code: "*426*203#" }, error: null })
    expect(await readPublicUssdCodes(db)).toEqual({ main: "*920#", shop: "*426*203#" })
  })
  it("nulls a missing or invalid shop dial code (never a default)", async () => {
    const main = { data: { value: '{"main":"*920#"}' }, error: null }
    expect((await readPublicUssdCodes(fakeDb(main))).shop).toBeNull()
    expect((await readPublicUssdCodes(fakeDb(main, { data: { ussd_shop_dial_code: "<b>" }, error: null }))).shop).toBeNull()
  })
  it("throws on a DB error in either row (so the admin GET can 500)", async () => {
    await expect(readPublicUssdCodes(fakeDb({ data: null, error: { message: "boom" } }))).rejects.toBeTruthy()
    await expect(
      readPublicUssdCodes(fakeDb({ data: null, error: null }, { data: null, error: { message: "boom" } })),
    ).rejects.toBeTruthy()
  })
  it("getPublicUssdCodes still swallows errors to nulls", async () => {
    const db = fakeDb({ data: null, error: { message: "boom" } })
    expect(await getPublicUssdCodes(db)).toEqual({ main: null, shop: null })
  })
})

const ok = (main: unknown) => validateUssdCodesInput({ main })

describe("validateUssdCodesInput", () => {
  it("accepts simple codes", () => {
    expect(ok("*920#")).toEqual({ ok: true, value: { main: "*920#" } })
    expect(ok("*920*44#")).toMatchObject({ ok: true })
  })

  it.each(["*920", "920#", "<script>", "*920#;drop", "*920*SHOPCODE#", "*920*" + "1".repeat(34) + "#"])("rejects %s", (bad) => {
    expect(ok(bad).ok).toBe(false)
  })

  it("empty or missing clears the field", () => {
    expect(ok("  ")).toEqual({ ok: true, value: { main: null } })
    expect(validateUssdCodesInput({})).toEqual({ ok: true, value: { main: null } })
  })

  it("trims values and rejects non-object bodies", () => {
    expect(ok("  *920#  ")).toEqual({ ok: true, value: { main: "*920#" } })
    expect(validateUssdCodesInput(null).ok).toBe(false)
    expect(ok(123).ok).toBe(false)
  })
})

describe("parseMainUssdCode", () => {
  it("reads main from the stored JSON", () => {
    expect(parseMainUssdCode('{"main":"*920#"}')).toBe("*920#")
    expect(parseMainUssdCode({ main: "*920#" })).toBe("*920#")
  })
  it("tolerates null, junk, non-JSON and the old SHOPCODE format", () => {
    expect(parseMainUssdCode(null)).toBeNull()
    expect(parseMainUssdCode("not json")).toBeNull()
    expect(parseMainUssdCode("[1]")).toBeNull()
    expect(parseMainUssdCode('{"main":"*920*SHOPCODE#"}')).toBeNull()
  })
})
