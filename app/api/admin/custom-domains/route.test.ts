import { GET, POST, PATCH, DELETE } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}))

const { setCacheMock, clearCacheMock } = vi.hoisted(() => ({
  setCacheMock: vi.fn(async () => {}),
  clearCacheMock: vi.fn(async () => {}),
}))
vi.mock("@/lib/custom-domain-lookup", () => ({
  setCustomDomainCache: setCacheMock,
  clearCustomDomainCache: clearCacheMock,
}))

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (...args: any[]) => fromMock(...args) },
}))

function makeBuilder(result: { data: any; error: any }) {
  const builder: any = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return builder
}

function postRequest(body: unknown, method = "POST") {
  return new NextRequest("http://localhost/api/admin/custom-domains", {
    method,
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/admin/custom-domains", () => {
  it("returns the list of configured domains", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: [{ id: "1", domain: "checkresults.com", service: "results_checker", site_name: "CheckResults", logo_url: null, primary_color: null, is_active: true, created_at: "2026-01-01", updated_at: "2026-01-01" }],
      error: null,
    }))
    const res = await GET(new NextRequest("http://localhost/api/admin/custom-domains"))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.domains).toHaveLength(1)
  })
})

describe("POST /api/admin/custom-domains", () => {
  it("rejects an unrecognized service", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", service: "not-a-service", site_name: "CheckResults" }))
    expect(res.status).toBe(400)
  })

  it("rejects a missing site_name", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", service: "results_checker", site_name: "" }))
    expect(res.status).toBe(400)
  })

  it("rejects a domain that collides with the root domain", async () => {
    const res = await POST(postRequest({ domain: "datagod.store", service: "airtime", site_name: "X" }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/collides/)
  })

  it("rejects a domain that collides with the shop-subdomain shape", async () => {
    const res = await POST(postRequest({ domain: "my-shop.datagod.store", service: "airtime", site_name: "X" }))
    expect(res.status).toBe(400)
  })

  it("normalizes a pasted https://www. URL before storing it, and write-throughs the cache", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: { id: "1", domain: "checkresults.com", service: "results_checker", site_name: "CheckResults", logo_url: null, primary_color: null, is_active: true },
      error: null,
    }))

    const res = await POST(postRequest({ domain: "https://www.CheckResults.com/", service: "results_checker", site_name: "CheckResults" }))
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.domain.domain).toBe("checkresults.com")
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ domain: "checkresults.com" }))
  })

  it("returns 409 when the domain already exists", async () => {
    fromMock.mockReturnValue(makeBuilder({ data: null, error: { code: "23505", message: "duplicate key" } }))
    const res = await POST(postRequest({ domain: "checkresults.com", service: "results_checker", site_name: "CheckResults" }))
    expect(res.status).toBe(409)
  })
})

describe("PATCH /api/admin/custom-domains", () => {
  it("requires an id", async () => {
    const res = await PATCH(postRequest({ site_name: "New Name" }, "PATCH"))
    expect(res.status).toBe(400)
  })

  it("clears the cache instead of writing to it when is_active is set to false", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: { id: "1", domain: "checkresults.com", service: "results_checker", site_name: "CheckResults", logo_url: null, primary_color: null, is_active: false },
      error: null,
    }))

    const res = await PATCH(postRequest({ id: "1", is_active: false }, "PATCH"))

    expect(res.status).toBe(200)
    expect(clearCacheMock).toHaveBeenCalledWith("checkresults.com")
    expect(setCacheMock).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/admin/custom-domains", () => {
  it("requires an id query param", async () => {
    const req = new NextRequest("http://localhost/api/admin/custom-domains", { method: "DELETE" })
    const res = await DELETE(req)
    expect(res.status).toBe(400)
  })

  it("clears the cache for the deleted domain", async () => {
    fromMock.mockReturnValue(makeBuilder({ data: { id: "1", domain: "checkresults.com" }, error: null }))
    const req = new NextRequest("http://localhost/api/admin/custom-domains?id=1", { method: "DELETE" })
    const res = await DELETE(req)
    expect(res.status).toBe(200)
    expect(clearCacheMock).toHaveBeenCalledWith("checkresults.com")
  })
})
