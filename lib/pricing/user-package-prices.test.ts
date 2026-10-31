import { describe, it, expect, vi } from "vitest"
import { fetchUserPackagePrices, parseUserPackagePrices, resolveDisplayPrices } from "./user-package-prices"

const pkgs = [
  { id: "a", network: "MTN", price: 10, dealer_price: 8 },
  { id: "b", network: "MTN", price: 5, dealer_price: 0 },
  { id: "c", network: "MTN", price: 3, dealer_price: null },
]

describe("resolveDisplayPrices", () => {
  it("uses the resolved price for every package and passes custom ids through", () => {
    const r = resolveDisplayPrices(pkgs, { prices: { a: 6, b: 5, c: 3 }, custom_ids: ["a"] }, false)
    expect(r.packages.map((p) => p.price)).toEqual([6, 5, 3])
    expect(r.customIds).toEqual(["a"])
    expect(r.fallback).toBe(false)
  })
  it("keeps the other package fields", () => {
    const r = resolveDisplayPrices(pkgs, { prices: { a: 6 }, custom_ids: [] }, false)
    expect(r.packages[0]).toMatchObject({ id: "a", network: "MTN", dealer_price: 8, price: 6 })
  })
  it("falls back to role prices (dealer rule) when nothing was resolved", () => {
    const dealer = resolveDisplayPrices(pkgs, null, true)
    expect(dealer.packages.map((p) => p.price)).toEqual([8, 5, 3])
    expect(dealer.fallback).toBe(true)
    expect(dealer.customIds).toEqual([])
    expect(resolveDisplayPrices(pkgs, null, false).packages.map((p) => p.price)).toEqual([10, 5, 3])
  })
  it("shows the role price for a package missing from the resolved map", () => {
    const r = resolveDisplayPrices(pkgs, { prices: { b: 5 }, custom_ids: [] }, true)
    expect(r.packages.map((p) => p.price)).toEqual([8, 5, 3])
  })
})

describe("parseUserPackagePrices", () => {
  it("accepts the endpoint body", () => {
    expect(parseUserPackagePrices({ pricing_mode: "custom", prices: { a: 6, b: "5" }, custom_ids: ["a"] })).toEqual({
      prices: { a: 6, b: 5 },
      custom_ids: ["a"],
    })
  })
  it("rejects a body without prices", () => {
    expect(parseUserPackagePrices({ error: "Unauthorized" })).toBeNull()
    expect(parseUserPackagePrices(null)).toBeNull()
  })
})

describe("fetchUserPackagePrices", () => {
  const ok = (body: unknown) => vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch
  it("sends the bearer token and returns the parsed body", async () => {
    const f = ok({ prices: { a: 6 }, custom_ids: ["a"] })
    expect(await fetchUserPackagePrices("tok", f)).toEqual({ prices: { a: 6 }, custom_ids: ["a"] })
    expect((f as any).mock.calls[0][0]).toBe("/api/user/package-prices")
    expect((f as any).mock.calls[0][1].headers.Authorization).toBe("Bearer tok")
  })
  it("returns null without a token, on an HTTP error, or when fetch throws", async () => {
    expect(await fetchUserPackagePrices(null, ok({ prices: {} }))).toBeNull()
    const bad = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    expect(await fetchUserPackagePrices("tok", bad)).toBeNull()
    const boom = vi.fn(async () => { throw new Error("net") }) as unknown as typeof fetch
    expect(await fetchUserPackagePrices("tok", boom)).toBeNull()
  })
})
