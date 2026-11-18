import { describe, it, expect } from "vitest"
import { priceLadder, resolveRolePrice, type RoleRow, type RolePriceMap } from "./ladder"
import { rolePrice, type PricedPackage } from "@/lib/pricing/package-price"

const role = (slug: string, rank: number | null, archived = false): RoleRow => ({
  id: `id-${slug}`,
  slug,
  rank,
  is_system: ["user", "dealer", "sub_agent", "admin"].includes(slug),
  archived_at: archived ? "2026-01-01T00:00:00Z" : null,
})

const roles: RoleRow[] = [
  role("user", 0),
  role("dealer", 10),
  role("super", 20),
  role("agent", 5, true),
  role("sub_agent", null),
  role("admin", null),
]

const pkg: PricedPackage = { id: "p1", price: 6, dealer_price: 5 }

const prices = (entries: Record<string, number>): RolePriceMap =>
  new Map(Object.entries(entries).map(([slug, price]) => [`id-${slug}`, new Map([["p1", price]])]))

describe("priceLadder", () => {
  it("walks down by rank, skipping archived", () => {
    expect(priceLadder(roles, "super").map((r) => r.slug)).toEqual(["super", "dealer", "user"])
  })
  it("off-ladder roles use only themselves", () => {
    expect(priceLadder(roles, "sub_agent").map((r) => r.slug)).toEqual(["sub_agent"])
    expect(priceLadder(roles, "admin").map((r) => r.slug)).toEqual(["admin"])
  })
  it("unknown, null, undefined, archived -> empty", () => {
    expect(priceLadder(roles, "nope")).toEqual([])
    expect(priceLadder(roles, null)).toEqual([])
    expect(priceLadder(roles, undefined)).toEqual([])
    expect(priceLadder(roles, "agent")).toEqual([])
  })
})

describe("resolveRolePrice", () => {
  it("uses own price", () => {
    expect(resolveRolePrice(pkg, "super", roles, prices({ super: 4.6, dealer: 5 }))).toBe(4.6)
  })
  it("falls back to lower rank", () => {
    expect(resolveRolePrice(pkg, "super", roles, prices({ dealer: 5 }))).toBe(5)
  })
  it("falls back to public price", () => {
    expect(resolveRolePrice(pkg, "super", roles, prices({}))).toBe(6)
  })
  it("unknown / null / archived slug gets public price, never a cheaper tier", () => {
    const p = prices({ dealer: 5, user: 5.5, agent: 1 })
    expect(resolveRolePrice(pkg, "nope", roles, p)).toBe(6)
    expect(resolveRolePrice(pkg, null, roles, p)).toBe(6)
    expect(resolveRolePrice(pkg, "agent", roles, p)).toBe(6)
  })
  it("off-ladder role does not inherit dealer price", () => {
    expect(resolveRolePrice(pkg, "sub_agent", roles, prices({ dealer: 5 }))).toBe(6)
  })

  describe("parity with rolePrice", () => {
    const cases: PricedPackage[] = [
      { id: "p1", price: 6, dealer_price: 5 },
      { id: "p1", price: 6, dealer_price: 0 },
      { id: "p1", price: 6, dealer_price: null },
    ]
    for (const c of cases) {
      it(`dealer_price=${c.dealer_price}`, () => {
        const dealer = Number(c.dealer_price ?? 0)
        const p = prices(dealer > 0 ? { dealer } : {})
        expect(resolveRolePrice(c, "dealer", roles, p)).toBe(rolePrice(c, true))
        expect(resolveRolePrice(c, "user", roles, p)).toBe(rolePrice(c, false))
        expect(resolveRolePrice(c, "sub_agent", roles, p)).toBe(rolePrice(c, false))
      })
    }
  })
})
