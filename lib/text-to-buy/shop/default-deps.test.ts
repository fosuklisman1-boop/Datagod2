import { describe, expect, it, vi } from "vitest"
import { shopCodeByIdWith } from "./default-deps"

const fakeDb = (row: { code?: unknown } | null, error: unknown = null) => {
  const eq = vi.fn((_c: string, _v: string) => ({ maybeSingle: async () => ({ data: row, error }) }))
  const select = vi.fn((_cols: string) => ({ eq }))
  const from = vi.fn((_t: string) => ({ select }))
  return { db: { from } as never, from, select, eq }
}
const SHOP = { shopCodeId: "i1", shopId: "s1", shopName: "S", parentShopId: null, status: "active", tokenBalance: 0, whatsappActivated: false }

describe("shopCodeByIdWith", () => {
  it("maps id to code to the exact lookup", async () => {
    const { db, from, eq } = fakeDb({ code: "kofi123" })
    const lookup = vi.fn(async () => SHOP)
    expect(await shopCodeByIdWith(db, lookup, "i1")).toBe(SHOP)
    expect(from).toHaveBeenCalledWith("ussd_shop_codes")
    expect(eq).toHaveBeenCalledWith("id", "i1")
    expect(lookup).toHaveBeenCalledWith("kofi123")
  })

  it("is null for a missing row, a read error, or a blank code, without a lookup", async () => {
    for (const f of [fakeDb(null), fakeDb({ code: "x" }, { message: "boom" }), fakeDb({ code: "" })]) {
      const lookup = vi.fn(async () => SHOP)
      expect(await shopCodeByIdWith(f.db, lookup, "i1")).toBeNull()
      expect(lookup).not.toHaveBeenCalled()
    }
  })
})
