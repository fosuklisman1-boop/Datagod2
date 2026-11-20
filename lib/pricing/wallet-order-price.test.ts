import { describe, it, expect } from "vitest"
import { walletOrderPrice } from "./wallet-order-price"
import { getCustomPrices } from "./package-price"
import { roleBasePrices, priceWith } from "@/lib/roles/pricing"

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]
const PKG = { id: "p1", size: "2", price: 10, dealer_price: 8, is_available: true }

function fakeDb(tables: Record<string, any[]>) {
  const builder = (t: string): any => {
    const b: any = new Proxy(function () {}, {
      get: (_x, p: string) => {
        if (p === "single" || p === "maybeSingle") return () => Promise.resolve({ data: (tables[t] ?? [])[0] ?? null, error: null })
        if (p === "then") return (r: any, j: any) => Promise.resolve({ data: tables[t] ?? [], error: null }).then(r, j)
        return () => b
      },
    })
    return b
  }
  return { from: builder } as any
}

// The route's original inline block, kept here as the oracle.
async function legacy(db: any, userId: string, role: string) {
  const custom = await getCustomPrices(db, userId)
  const base = await roleBasePrices(db, role, [PKG], { admin: "as_user" })
  return priceWith(base, PKG, custom)
}

describe("walletOrderPrice", () => {
  const cases: Array<[string, string, Record<string, any[]>, number]> = [
    ["user", "user", { users: [{ pricing_mode: null }], roles: ROLES, role_package_prices: [], user_package_prices: [] }, 10],
    ["dealer", "dealer", { users: [{ pricing_mode: null }], roles: ROLES, role_package_prices: [{ role_id: "r-dealer", package_id: "p1", price: 8 }], user_package_prices: [] }, 8],
    ["sub_agent", "sub_agent", { users: [{ pricing_mode: null }], roles: ROLES, role_package_prices: [{ role_id: "r-dealer", package_id: "p1", price: 8 }], user_package_prices: [] }, 10],
    ["custom-price user", "user", { users: [{ pricing_mode: "custom" }], roles: ROLES, role_package_prices: [], user_package_prices: [{ package_id: "p1", price: 6.25 }] }, 6.25],
  ]
  for (const [name, role, tables, expected] of cases) {
    it(`wallet_order_price_matches_route: ${name}`, async () => {
      const db = fakeDb(tables)
      const got = await walletOrderPrice(db, "user-1", role, PKG)
      expect(got).toBe(expected)
      expect(got).toBe(await legacy(db, "user-1", role))
    })
  }
})
