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
      data: [{ id: "1", domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults", logo_url: null, primary_color: null, is_active: true, created_at: "2026-01-01", updated_at: "2026-01-01" }],
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
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["not-a-service"], site_name: "CheckResults" }))
    expect(res.status).toBe(400)
  })

  it("rejects a missing services array", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", site_name: "CheckResults" }))
    expect(res.status).toBe(400)
  })

  it("rejects an empty services array", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", services: [], site_name: "CheckResults" }))
    expect(res.status).toBe(400)
  })

  it("rejects a non-array services value", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", services: "results_checker", site_name: "CheckResults" }))
    expect(res.status).toBe(400)
  })

  it("rejects a missing site_name", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["results_checker"], site_name: "" }))
    expect(res.status).toBe(400)
  })

  it("rejects a domain that collides with the root domain", async () => {
    const res = await POST(postRequest({ domain: "datagod.store", services: ["airtime"], site_name: "X" }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/collides/)
  })

  it("rejects a domain that collides with the shop-subdomain shape", async () => {
    const res = await POST(postRequest({ domain: "my-shop.datagod.store", services: ["airtime"], site_name: "X" }))
    expect(res.status).toBe(400)
  })

  it("normalizes a pasted https://www. URL before storing it, and write-throughs the cache", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: { id: "1", domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults", logo_url: null, primary_color: null, is_active: true },
      error: null,
    }))

    const res = await POST(postRequest({ domain: "https://www.CheckResults.com/", services: ["results_checker"], site_name: "CheckResults" }))
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.domain.domain).toBe("checkresults.com")
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ domain: "checkresults.com", services: ["results_checker"] }))
  })

  it("accepts multiple services and deduplicates repeats", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: { id: "1", domain: "checkresults.com", services: ["results_checker", "airtime"], site_name: "CheckResults", logo_url: null, primary_color: null, is_active: true },
      error: null,
    }))

    const res = await POST(postRequest({ domain: "checkresults.com", services: ["results_checker", "airtime", "airtime"], site_name: "CheckResults" }))

    expect(res.status).toBe(201)
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ services: ["results_checker", "airtime"] }))
  })

  it("returns 409 when the domain already exists", async () => {
    fromMock.mockReturnValue(makeBuilder({ data: null, error: { code: "23505", message: "duplicate key" } }))
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults" }))
    expect(res.status).toBe(409)
  })

  it("rejects a linked_shop_id that doesn't exist in user_shops", async () => {
    // Every fromMock() call in this test resolves the same way — the
    // validation lookup finds nothing, and the route must return 400 before
    // ever reaching a second, differently-shaped call (the custom_domains
    // insert), so a single uniform mock is sufficient here.
    fromMock.mockReturnValue(makeBuilder({ data: null, error: null }))
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["data_bundles"], site_name: "X", linked_shop_id: "11111111-1111-1111-1111-111111111111" }))
    expect(res.status).toBe(400)
  })

  it("accepts a valid linked_shop_id, defaults show_guest_purchase/show_landing_page, and caches the shop's subdomain", async () => {
    fromMock.mockImplementation((table: string) =>
      table === "user_shops"
        ? makeBuilder({ data: { id: "11111111-1111-1111-1111-111111111111", subdomain: "myshop", is_active: true, is_blocked: false }, error: null })
        : makeBuilder({
            data: { id: "1", domain: "checkresults.com", services: ["data_bundles"], site_name: "X", logo_url: null, primary_color: null, is_active: true, linked_shop_id: "11111111-1111-1111-1111-111111111111", show_guest_purchase: false, show_landing_page: true },
            error: null,
          })
    )
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["data_bundles"], site_name: "X", linked_shop_id: "11111111-1111-1111-1111-111111111111" }))
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ show_guest_purchase: false, show_landing_page: true, linked_shop_subdomain: "myshop" }))
  })
})

describe("PATCH /api/admin/custom-domains", () => {
  it("requires an id", async () => {
    const res = await PATCH(postRequest({ site_name: "New Name" }, "PATCH"))
    expect(res.status).toBe(400)
  })

  it("rejects an empty services array on update", async () => {
    const res = await PATCH(postRequest({ id: "1", services: [] }, "PATCH"))
    expect(res.status).toBe(400)
  })

  it("clears the cache instead of writing to it when is_active is set to false", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: { id: "1", domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults", logo_url: null, primary_color: null, is_active: false },
      error: null,
    }))

    const res = await PATCH(postRequest({ id: "1", is_active: false }, "PATCH"))

    expect(res.status).toBe(200)
    expect(clearCacheMock).toHaveBeenCalledWith("checkresults.com")
    expect(setCacheMock).not.toHaveBeenCalled()
  })

  it("rejects a non-boolean show_landing_page on update", async () => {
    const res = await PATCH(postRequest({ id: "1", show_landing_page: "yes" }, "PATCH"))
    expect(res.status).toBe(400)
  })

  it("re-resolves and caches the correct linked_shop_subdomain on a PATCH that doesn't touch linked_shop_id", async () => {
    // This domain is ALREADY shop-linked (linked_shop_id present in the
    // post-update row) even though this PATCH's body only renames site_name —
    // the cache write must still carry the real subdomain, not null, or live
    // shop-mode traffic on this domain gets silently misrouted for up to 5
    // minutes (the bug this fix round addresses).
    fromMock.mockImplementation((table: string) =>
      table === "user_shops"
        ? makeBuilder({ data: { subdomain: "myshop" }, error: null })
        : makeBuilder({
            data: { id: "1", domain: "checkresults.com", services: ["data_bundles"], site_name: "Renamed", logo_url: null, primary_color: null, is_active: true, linked_shop_id: "11111111-1111-1111-1111-111111111111", show_guest_purchase: false, show_landing_page: true },
            error: null,
          })
    )
    const res = await PATCH(postRequest({ id: "1", site_name: "Renamed" }, "PATCH"))
    expect(res.status).toBe(200)
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ linked_shop_subdomain: "myshop" }))
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
