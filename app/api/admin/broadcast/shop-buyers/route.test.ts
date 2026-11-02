import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
const loadShopBuyerCounts = vi.fn()
vi.mock("@/lib/sms/shop-buyers", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sms/shop-buyers")>()),
  loadShopBuyerCounts: (...a: unknown[]) => loadShopBuyerCounts(...a),
  countOptOuts: async () => 4,
}))

import { GET } from "./route"

const get = (q = "") => GET(new NextRequest(`http://x/api/admin/broadcast/shop-buyers${q}`))

describe("GET /api/admin/broadcast/shop-buyers", () => {
  it("returns per-shop counts, total and opted-out count for the window", async () => {
    loadShopBuyerCounts.mockResolvedValueOnce({ shops: [{ id: "a", name: "A", subdomain: "a", link: "https://a.datagod.store", buyers: 5 }], total: 5 })
    const res = await get("?since=90")
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ total: 5, optedOut: 4 })
    expect(loadShopBuyerCounts.mock.calls[0][1]).toBe(90)
  })

  it("rejects an unknown window", async () => {
    expect((await get("?since=7")).status).toBe(400)
  })

  it("explains when migration 0145 hasn't been run", async () => {
    loadShopBuyerCounts.mockRejectedValueOnce({ code: "PGRST202" })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await get()
    spy.mockRestore()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/0145/)
  })
})
