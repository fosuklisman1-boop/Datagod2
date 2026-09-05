import { GET, POST } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}))

const upsertMock = vi.fn(async () => ({ error: null }))
const maybeSingleMock = vi.fn(async () => ({ data: null, error: null }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }),
      upsert: upsertMock,
    }),
  },
}))

describe("GET /api/admin/settings/customer-verification", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the default settings plus the list of available providers", async () => {
    const req = new NextRequest("http://localhost/api/admin/settings/customer-verification")
    const res = await GET(req)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.settings).toEqual({ enabled: false, providers: [] })
    expect(Array.isArray(body.availableProviders)).toBe(true)
    expect(body.availableProviders.length).toBeGreaterThan(0)
  })
})

describe("POST /api/admin/settings/customer-verification", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects a non-boolean enabled value", async () => {
    const req = new NextRequest("http://localhost/api/admin/settings/customer-verification", {
      method: "POST",
      body: JSON.stringify({ enabled: "yes", providers: [] }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it("rejects an unknown provider name via validateProviderSelection", async () => {
    const req = new NextRequest("http://localhost/api/admin/settings/customer-verification", {
      method: "POST",
      body: JSON.stringify({ enabled: true, providers: ["not-a-real-provider"] }),
    })
    const res = await POST(req)
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/Unknown provider/)
  })

  it("accepts enabled:true with an empty provider list (feature on, nothing selected yet)", async () => {
    const req = new NextRequest("http://localhost/api/admin/settings/customer-verification", {
      method: "POST",
      body: JSON.stringify({ enabled: true, providers: [] }),
    })
    const res = await POST(req)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.settings).toEqual({ enabled: true, providers: [] })
    expect(upsertMock).toHaveBeenCalled()
  })
})
