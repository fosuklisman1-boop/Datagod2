import { GET, POST } from "./route"
import { NextRequest, NextResponse } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: (...a: unknown[]) => verifyMock(...a),
}))

const upsert = vi.fn(async (..._a: unknown[]) => ({ error: null as null | { message: string } }))
const maybeSingle = vi.fn(async () => ({ data: null as any }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: (...a: unknown[]) => upsert(...a),
      select: () => ({ eq: () => ({ maybeSingle: () => maybeSingle() }) }),
    }),
  },
}))

const url = "http://localhost/api/admin/settings/ussd-shop-memory"
const post = async (body: unknown) => (await POST(new NextRequest(url, { method: "POST", body: JSON.stringify(body) })))!
const get = async () => (await GET(new NextRequest(url)))!

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  verifyMock.mockResolvedValue({ isAdmin: true, userId: "admin-1", userEmail: "a@x" })
  maybeSingle.mockResolvedValue({ data: null })
})

describe("/api/admin/settings/ussd-shop-memory", () => {
  it("401 without admin", async () => {
    verifyMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "no" }, { status: 401 }) })
    const res = await post({ enabled: true })
    expect(res.status).toBe(401)
    expect(upsert).not.toHaveBeenCalled()
    const g = await get()
    expect(g.status).toBe(401)
  })

  it("400 when enabled is not boolean", async () => {
    const res = await post({ enabled: "yes" })
    expect(res.status).toBe(400)
    expect(upsert).not.toHaveBeenCalled()
  })

  it("POST upserts key ussd_shop_memory_enabled {enabled:true}", async () => {
    const res = await post({ enabled: true })
    expect(res.status).toBe(200)
    const [row, opts] = upsert.mock.calls[0] as any
    expect(row.key).toBe("ussd_shop_memory_enabled")
    expect(row.value).toEqual({ enabled: true })
    expect(opts).toEqual({ onConflict: "key" })
  })

  it("GET returns enabled false when no row", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(false)
  })
})
