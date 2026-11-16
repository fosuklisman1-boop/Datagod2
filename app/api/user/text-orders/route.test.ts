import { describe, it, expect, vi, beforeEach } from "vitest"

let authUser: { id: string } | null = { id: "user-1" }
const loadOwnerRaw = vi.fn()

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: authUser }, error: authUser ? null : new Error("bad") }) },
  },
}))
vi.mock("@/lib/text-to-buy/owner-view", async (orig) => ({
  ...(await orig<typeof import("@/lib/text-to-buy/owner-view")>()),
  loadOwnerRaw: (...a: unknown[]) => loadOwnerRaw(...a),
}))

import { GET } from "./route"

const req = (auth = true, qs = "") => new Request(`http://x/api/user/text-orders${qs}`, { headers: auth ? { authorization: "Bearer tok" } : {} }) as never

const raw = {
  shopEnabled: true,
  shopNumber: "0559919037",
  shop: { name: "Datago", isActive: true, isBlocked: false },
  code: { code: "8468", status: "active" },
  account: { status: "active", balance: 50 },
  orders: [{ id: "o1", size: "5GB", recipient: "0241234567", gift: false, amount: 22, state: "closed", created_at: "2026-11-16T10:00:00Z", paid_at: "2026-11-16T10:01:00Z", delivered_at: "2026-11-16T10:03:00Z" }],
  windowOrders: [{ paid_at: "2026-11-16T10:01:00Z", delivered_at: "2026-11-16T10:03:00Z" }],
  credits30d: 3,
}

beforeEach(() => {
  authUser = { id: "user-1" }
  loadOwnerRaw.mockReset()
})

describe("GET /api/user/text-orders", () => {
  it("401 without a Bearer token and reads nothing", async () => {
    const res = await GET(req(false))
    expect(res.status).toBe(401)
    expect(loadOwnerRaw).not.toHaveBeenCalled()
  })

  it("derives the shop from the session user, ignoring any id in the query", async () => {
    loadOwnerRaw.mockResolvedValue(raw)
    const res = await GET(req(true, "?userId=someone-else&shopId=other"))
    expect(res.status).toBe(200)
    expect(loadOwnerRaw.mock.calls[0][1]).toBe("user-1")
  })

  it("returns the built view with a masked recipient and no raw phone anywhere", async () => {
    loadOwnerRaw.mockResolvedValue(raw)
    const body = await (await GET(req())).json()
    expect(body).toMatchObject({ hasShop: true, status: "live", shopCode: "8468", balance: 50 })
    expect(body.orders[0].recipient).toBe("024••••567")
    expect(JSON.stringify(body)).not.toContain("0241234567")
  })

  it("hasShop false (200) for a user who owns no shop", async () => {
    loadOwnerRaw.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hasShop: false })
  })

  it("500 with a fixed message when the read fails, never the error text", async () => {
    loadOwnerRaw.mockRejectedValue(new Error("secret row 0241234567"))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("0241234567")
  })
})
