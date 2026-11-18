import { describe, expect, it } from "vitest"
import { effectivePrice, NO_CUSTOM_PRICES } from "@/lib/pricing/package-price"
import { priceWith, pricingSlug, roleBasePrices, roleBasePricesOrPublic } from "./pricing"
import { RoleReadError } from "./repo"

type Result = { data: unknown; error: unknown }

/** Minimal fake: from(table).select().in()...limit() is awaitable; `respond(table, filters)` decides each result. */
function fakeClient(respond: (table: string, filters: Array<[string, unknown[]]>) => Result) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown[]]> = []
      const b: any = {
        select: () => b,
        limit: () => b,
        in: (col: string, vals: unknown[]) => (filters.push([col, vals]), b),
        then: (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(respond(table, filters)).then(res, rej)
          } catch (e) {
            return Promise.reject(e).then(res, rej)
          }
        },
      }
      return b
    },
  }
}

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]

const PKGS = [
  { id: "p1", price: 6, dealer_price: 5 },
  { id: "p2", price: 6, dealer_price: 0 },
  { id: "p3", price: 6, dealer_price: null },
]

// Seeded mirror: a dealer row only when dealer_price > 0.
const seeded = fakeClient((table) =>
  table === "roles"
    ? { data: ROLES, error: null }
    : { data: [{ role_id: "r-dealer", package_id: "p1", price: 5 }], error: null }
)

const failing = fakeClient(() => ({ data: null, error: { message: "boom" } }))

describe("pricingSlug", () => {
  it("applies the per-caller admin rule", () => {
    expect(pricingSlug("admin", "as_user")).toBe("user")
    expect(pricingSlug("admin", "as_dealer")).toBe("dealer")
  })
  it("defaults empty roles to user and leaves others unchanged", () => {
    expect(pricingSlug(null, "as_user")).toBe("user")
    expect(pricingSlug(undefined, "as_dealer")).toBe("user")
    expect(pricingSlug("", "as_dealer")).toBe("user")
    expect(pricingSlug("dealer", "as_user")).toBe("dealer")
    expect(pricingSlug("sub_agent", "as_dealer")).toBe("sub_agent")
    expect(pricingSlug("gold", "as_user")).toBe("gold")
  })
})

describe("roleBasePrices parity with the old isDealer rule", () => {
  for (const role of ["user", "dealer", "sub_agent", "admin"]) {
    for (const admin of ["as_user", "as_dealer"] as const) {
      it(`${role} / ${admin}`, async () => {
        const isDealer = admin === "as_user" ? role === "dealer" : role === "dealer" || role === "admin"
        const base = await roleBasePrices(seeded, role, PKGS, { admin })
        for (const pkg of PKGS) {
          expect(priceWith(base, pkg, NO_CUSTOM_PRICES)).toBe(effectivePrice(pkg, isDealer, NO_CUSTOM_PRICES))
        }
      })
    }
  }
})

describe("priceWith", () => {
  const base = new Map([["p1", 6]])
  it("custom price wins over base", () => {
    expect(priceWith(base, { id: "p1" }, new Map([["p1", 4.2]]))).toBe(4.2)
  })
  it("numeric ids are string-keyed", () => {
    expect(priceWith(new Map([["7", 3]]), { id: 7 }, NO_CUSTOM_PRICES)).toBe(3)
  })
  it("throws (never 0) when neither map has the package", () => {
    expect(() => priceWith(base, { id: "zz" }, NO_CUSTOM_PRICES)).toThrow("no base price for package zz")
  })
})

describe("failure handling", () => {
  it("roleBasePrices rejects RoleReadError", async () => {
    await expect(roleBasePrices(failing, "dealer", PKGS, { admin: "as_user" })).rejects.toBeInstanceOf(RoleReadError)
  })
  it("roleBasePricesOrPublic falls back to public prices", async () => {
    const m = await roleBasePricesOrPublic(failing, "dealer", PKGS, { admin: "as_user" })
    expect([...m.entries()]).toEqual([["p1", 6], ["p2", 6], ["p3", 6]])
  })
  it("roleBasePricesOrPublic also falls back when from() throws (repo wraps it as RoleReadError)", async () => {
    const pkgs = [{ id: "p1", price: 6 }]
    const client = { from: () => { throw new Error("x") } }
    expect((await roleBasePricesOrPublic(client, "dealer", pkgs, { admin: "as_user" })).get("p1")).toBe(6)
  })
})
