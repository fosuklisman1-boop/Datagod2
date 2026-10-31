// lib/pricing/package-price.test.ts
import { describe, it, expect } from "vitest"
import {
  CustomPriceReadError,
  NO_CUSTOM_PRICES,
  customPricesForUser,
  effectivePrice,
  getCustomPrices,
  ownerSaving,
  rolePrice,
} from "./package-price"

const pkg = { id: "p1", price: 10, dealer_price: 8 }

describe("rolePrice", () => {
  it("dealer gets dealer_price when > 0", () => expect(rolePrice(pkg, true)).toBe(8))
  it("dealer gets price when dealer_price is 0, null or missing", () => {
    expect(rolePrice({ id: "p", price: 10, dealer_price: 0 }, true)).toBe(10)
    expect(rolePrice({ id: "p", price: 10, dealer_price: null }, true)).toBe(10)
    expect(rolePrice({ id: "p", price: 10 }, true)).toBe(10)
  })
  it("non-dealer gets price", () => expect(rolePrice(pkg, false)).toBe(10))
  it("accepts numeric strings from PostgREST", () => expect(rolePrice({ id: "p", price: "10.50", dealer_price: "9.25" }, true)).toBe(9.25))
})

describe("effectivePrice", () => {
  it("custom price wins over the role price", () => {
    expect(effectivePrice(pkg, true, new Map([["p1", 7.5]]))).toBe(7.5)
    expect(effectivePrice(pkg, false, new Map([["p1", 7.5]]))).toBe(7.5)
  })
  it("falls back to the role price when the package has no custom price", () => {
    expect(effectivePrice(pkg, true, new Map([["other", 1]]))).toBe(8)
    expect(effectivePrice(pkg, false, NO_CUSTOM_PRICES)).toBe(10)
  })
})

describe("ownerSaving", () => {
  it("is role price minus custom price", () => expect(ownerSaving(pkg, true, new Map([["p1", 7]]))).toBe(1))
  it("is 0 with no custom price", () => expect(ownerSaving(pkg, true, NO_CUSTOM_PRICES)).toBe(0))
  it("is negative when the custom price is above the role price", () => expect(ownerSaving(pkg, false, new Map([["p1", 12]]))).toBe(-2))
  it("is +0, never -0, when prices are equal", () => expect(Object.is(ownerSaving(pkg, false, new Map([["p1", 10.001]])), 0)).toBe(true))
  it("rounds to pesewas", () => expect(ownerSaving({ id: "p1", price: 10.1, dealer_price: null }, false, new Map([["p1", 9.9]]))).toBe(0.2))
})

// Minimal PostgREST-shaped fake: users -> single(); user_package_prices -> thenable.
function client(opts: { noModeField?: boolean; throwUser?: boolean; throwPrices?: boolean; mode?: string | null; userError?: boolean; rows?: unknown[]; pricesError?: boolean }) {
  const calls: string[] = []
  return {
    calls,
    from(table: string) {
      calls.push(table)
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          if (opts.throwUser) throw new Error("net")
          return Promise.resolve(
            opts.userError
              ? { data: null, error: { message: "boom" } }
              : { data: opts.noModeField ? {} : opts.mode === null ? null : { pricing_mode: opts.mode ?? "role" }, error: null }
          )
        },
        then: (res: any, rej: any) =>
          opts.throwPrices ? Promise.reject(new Error("net")).then(res, rej) : Promise.resolve(opts.pricesError ? { data: null, error: { message: "boom" } } : { data: opts.rows ?? [], error: null }).then(res, rej),
      }
      return chain
    },
  }
}

describe("getCustomPrices", () => {
  it("treats a user row without pricing_mode as role mode (no re-read loop)", async () => {
    const c = client({ noModeField: true, rows: [{ package_id: "p1", price: 5 }] })
    expect((await getCustomPrices(c as any, "u1")).size).toBe(0)
    expect(c.calls).toEqual(["users"])
  })
  it("returns nothing for no user", async () => {
    const c = client({})
    expect((await getCustomPrices(c as any, null)).size).toBe(0)
    expect(c.calls).toEqual([])
  })
  it("returns nothing in role mode without reading prices", async () => {
    const c = client({ mode: "role", rows: [{ package_id: "p1", price: 5 }] })
    expect((await getCustomPrices(c as any, "u1")).size).toBe(0)
    expect(c.calls).toEqual(["users"])
  })
  it("returns nothing when the user row is missing", async () => {
    expect((await getCustomPrices(client({ mode: null }) as any, "u1")).size).toBe(0)
  })
  it("returns the saved prices in custom mode", async () => {
    const m = await getCustomPrices(client({ mode: "custom", rows: [{ package_id: "p1", price: "5.50" }, { package_id: "p2", price: 3 }] }) as any, "u1")
    expect(m.get("p1")).toBe(5.5)
    expect(m.get("p2")).toBe(3)
  })
  it("throws CustomPriceReadError when the user read fails", async () => {
    await expect(getCustomPrices(client({ userError: true }) as any, "u1")).rejects.toBeInstanceOf(CustomPriceReadError)
  })
  it("throws CustomPriceReadError when the price read fails", async () => {
    await expect(getCustomPrices(client({ mode: "custom", pricesError: true }) as any, "u1")).rejects.toBeInstanceOf(CustomPriceReadError)
  })
  it("ignores malformed rows", async () => {
    const m = await getCustomPrices(client({ mode: "custom", rows: [{ package_id: "p1", price: "x" }, { package_id: null, price: 2 }, { package_id: "p3", price: 0 }] }) as any, "u1")
    expect(m.size).toBe(0)
  })
})

describe("client exceptions", () => {
  it("getCustomPrices rejects when the user read throws", async () => {
    await expect(getCustomPrices(client({ throwUser: true }) as any, "u1")).rejects.toBeInstanceOf(CustomPriceReadError)
  })
  it("getCustomPrices rejects when the price read throws", async () => {
    await expect(getCustomPrices(client({ mode: "custom", throwPrices: true }) as any, "u1")).rejects.toBeInstanceOf(CustomPriceReadError)
  })
})

describe("customPricesForUser", () => {
  it("reads the mode when it was not loaded (undefined)", async () => {
    const c = client({ mode: "custom", rows: [{ package_id: "p1", price: 4 }] })
    const m = await customPricesForUser(c as any, { id: "u1" })
    expect(m.get("p1")).toBe(4)
    expect(c.calls).toEqual(["users", "user_package_prices"])
  })
  it("null mode means role mode", async () => {
    const c = client({})
    expect((await customPricesForUser(c as any, { id: "u1", pricing_mode: null })).size).toBe(0)
    expect(c.calls).toEqual([])
  })
  it("skips the users read when the mode is already known", async () => {
    const c = client({ rows: [{ package_id: "p1", price: 4 }] })
    const m = await customPricesForUser(c as any, { id: "u1", pricing_mode: "custom" })
    expect(m.get("p1")).toBe(4)
    expect(c.calls).toEqual(["user_package_prices"])
  })
  it("role mode reads nothing", async () => {
    const c = client({})
    expect((await customPricesForUser(c as any, { id: "u1", pricing_mode: "role" })).size).toBe(0)
    expect(c.calls).toEqual([])
  })
})
