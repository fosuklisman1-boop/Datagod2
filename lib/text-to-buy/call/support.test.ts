import { describe, expect, it } from "vitest"
import { readSupportWhatsapp } from "./support"

const fakeDb = (data: unknown, error: unknown = null, boom = false) => {
  const from = (_t: string) => ({
    select: (_c: string) => ({
      limit: (_n: number) => ({
        maybeSingle: async () => {
          if (boom) throw new Error("db down")
          return { data, error }
        },
      }),
    }),
  })
  return { from } as never
}

describe("readSupportWhatsapp", () => {
  it("returns the digits only", async () => {
    expect(await readSupportWhatsapp(fakeDb({ support_whatsapp: "+233 55-991 9037" }))).toBe("233559919037")
  })
  it("is null for empty, missing, non-digit, error and thrown reads", async () => {
    expect(await readSupportWhatsapp(fakeDb({ support_whatsapp: "" }))).toBeNull()
    expect(await readSupportWhatsapp(fakeDb({ support_whatsapp: "  -- " }))).toBeNull()
    expect(await readSupportWhatsapp(fakeDb({ support_whatsapp: null }))).toBeNull()
    expect(await readSupportWhatsapp(fakeDb(null))).toBeNull()
    expect(await readSupportWhatsapp(fakeDb({ support_whatsapp: "233" }, { message: "x" }))).toBeNull()
    expect(await readSupportWhatsapp(fakeDb(null, null, true))).toBeNull()
  })
  it("is null for an implausible length", async () => {
    expect(await readSupportWhatsapp(fakeDb({ support_whatsapp: "12" }))).toBeNull()
    expect(await readSupportWhatsapp(fakeDb({ support_whatsapp: "1".repeat(20) }))).toBeNull()
  })
})
