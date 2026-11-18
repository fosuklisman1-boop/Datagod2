import { describe, it, expect, vi } from "vitest"

// realDataDeps() builds its Supabase client with getAdminClient(); inject a table-serving fake.
const h = vi.hoisted(() => {
  const state = { tables: {} as Record<string, any[]> }
  const builder = (table: string): any =>
    new Proxy(function () {}, {
      get: (_t, p: string) => {
        if (p === "then")
          return (r: any, j: any) => Promise.resolve({ data: state.tables[table] ?? [], error: null }).then(r, j)
        return () => builder(table)
      },
    })
  return { state, client: { from: (t: string) => builder(t) } }
})

vi.mock("../store", () => ({ getAdminClient: () => h.client }))
vi.mock("next/server", () => ({ after: vi.fn() }))

import { realDataDeps } from "./data-deps"

// 0184 seed, plus a dealer price row.
const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]
const PKGS = [{ id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8 }]

function seed() {
  h.state.tables = {
    roles: ROLES,
    role_package_prices: [{ role_id: "r-dealer", package_id: "p1", price: 8 }],
  }
}

describe("realDataDeps().basePrices (admin wiring)", () => {
  it("an admin key is priced as a user (public price) even when dealer rows exist", async () => {
    seed()
    const base = await realDataDeps().basePrices("admin", PKGS)
    expect(base.get("p1")).toBe(10)
  })

  it("a dealer key gets the dealer price", async () => {
    seed()
    const base = await realDataDeps().basePrices("dealer", PKGS)
    expect(base.get("p1")).toBe(8)
  })
})
