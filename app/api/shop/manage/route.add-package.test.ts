import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// shop_packages rows already stored for (shop-1, pkg-1); user_shops ownership always passes.
let existingPackageRow: { id: string } | null = null
let inserted: Record<string, unknown>[] = []
let updated: { id: unknown; payload: Record<string, unknown> }[] = []

function shopPackagesTable() {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: existingPackageRow, error: null }),
    insert: (rows: Record<string, unknown>[]) => {
      inserted.push(...rows)
      return { select: () => ({ single: async () => ({ data: { id: "new-row", ...rows[0] }, error: null }) }) }
    },
    update: (payload: Record<string, unknown>) => ({
      eq: (_col: string, id: unknown) => {
        updated.push({ id, payload })
        return { select: () => ({ single: async () => ({ data: { id, ...payload }, error: null }) }) }
      },
    }),
  }
  return chain
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) =>
      table === "shop_packages"
        ? shopPackagesTable()
        : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "shop-1", user_id: "user-1" }, error: null }) }) }) },
  }),
}))

import { POST } from "./route"

const addPackage = () =>
  POST(
    new NextRequest("https://x.test/api/shop/manage", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ action: "add_package", shopId: "shop-1", packageId: "pkg-1", profitMargin: 2 }),
    }),
  )

describe("POST /api/shop/manage add_package", () => {
  beforeEach(() => {
    existingPackageRow = null
    inserted = []
    updated = []
  })

  it("inserts a new row when the shop doesn't have the package yet", async () => {
    const res = await addPackage()
    expect(res.status).toBe(200)
    expect(inserted).toEqual([{ shop_id: "shop-1", package_id: "pkg-1", profit_margin: 2, custom_name: null, is_available: true }])
    expect(updated).toEqual([])
  })

  it("re-adding a package the shop already has updates that row instead of inserting a duplicate", async () => {
    existingPackageRow = { id: "row-1" }
    const res = await addPackage()
    expect(res.status).toBe(200)
    expect(inserted).toEqual([])
    expect(updated).toHaveLength(1)
    expect(updated[0].id).toBe("row-1")
    expect(updated[0].payload).toMatchObject({ profit_margin: 2, is_available: true })
  })
})
