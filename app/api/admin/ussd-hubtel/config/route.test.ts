import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  auth: { isAdmin: true, userId: "admin-1" } as any,
  get: vi.fn(),
  set: vi.fn(),
  envReady: vi.fn(),
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@/lib/ussd-hubtel/config", () => ({
  getHubtelUssdConfig: (...a: any[]) => h.get(...a),
  setHubtelUssdConfig: (...a: any[]) => h.set(...a),
  hubtelEnvReady: (...a: any[]) => h.envReady(...a),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: () => Promise.resolve({ error: null }) }) }),
}))

import { GET, POST } from "./route"

const base = { enabled: false, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/ussd-hubtel/config", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  h.auth = { isAdmin: true, userId: "admin-1" }
  h.get.mockReset().mockResolvedValue(base)
  h.set.mockReset().mockResolvedValue({ ...base, mode: "shop" })
  h.envReady.mockReset().mockReturnValue({ ready: true, missing: [] })
})

describe("POST /api/admin/ussd-hubtel/config: mode", () => {
  it("accepts mode 'shop'", async () => {
    const res = await POST(post({ mode: "shop" }))
    expect(res.status).toBe(200)
    expect(h.set.mock.calls[0][1]).toMatchObject({ mode: "shop" })
  })
  it("still accepts mode 'main'", async () => {
    h.set.mockResolvedValue(base)
    const res = await POST(post({ mode: "main" }))
    expect(res.status).toBe(200)
    expect(h.set.mock.calls[0][1]).toMatchObject({ mode: "main" })
  })
  it("rejects any other mode with 400 and writes nothing", async () => {
    for (const mode of ["bogus", "", "Shop", 1, null]) {
      const res = await POST(post({ mode }))
      expect(res.status, String(mode)).toBe(400)
      expect(await res.json()).toEqual({ error: "mode must be 'main' or 'shop'" })
    }
    expect(h.set).not.toHaveBeenCalled()
  })
  it("rejects a null or non-object body with 400", async () => {
    for (const body of [null, "x", 5]) {
      const res = await POST(post(body))
      expect(res.status, String(body)).toBe(400)
    }
    expect(h.set).not.toHaveBeenCalled()
  })
  it("keeps the enabled-requires-env gate", async () => {
    h.envReady.mockReturnValue({ ready: false, missing: ["HUBTEL_RELAY_URL"] })
    const res = await POST(post({ enabled: true, mode: "shop" }))
    expect(res.status).toBe(400)
    expect(h.set).not.toHaveBeenCalled()
  })
  it("(I4) a rate-limited admin (isAdmin true + 429 errorResponse) gets the 429 and nothing is written", async () => {
    const { NextResponse } = await import("next/server")
    h.auth = { isAdmin: true, userId: "admin-1", errorResponse: NextResponse.json({ error: "Too many requests" }, { status: 429 }) }
    const res = await POST(post({ mode: "shop" }))
    expect(res.status).toBe(429)
    expect(h.set).not.toHaveBeenCalled()
    expect(h.get).not.toHaveBeenCalled()
    const g = await GET(new NextRequest("http://localhost/api/admin/ussd-hubtel/config"))
    expect(g.status).toBe(429)
    expect(h.get).not.toHaveBeenCalled()
  })
  it("returns the auth error response for non-admins", async () => {
    const { NextResponse } = await import("next/server")
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "no" }, { status: 403 }) }
    const res = await POST(post({ mode: "shop" }))
    expect(res.status).toBe(403)
    expect(h.set).not.toHaveBeenCalled()
  })
})

describe("(M3) shop mode needs Redis in production", () => {
  const prod = (redis: boolean) => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("UPSTASH_REDIS_REST_URL", redis ? "https://redis.example" : "")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", redis ? "tok" : "")
  }
  afterEach(() => { vi.unstubAllEnvs() })

  it("production without Redis: mode 'shop' is refused with 400 and nothing is written", async () => {
    prod(false)
    const res = await POST(post({ mode: "shop" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/UPSTASH_REDIS_REST_URL/)
    expect(h.set).not.toHaveBeenCalled()
  })
  it("VERCEL set (preview) without Redis: also refused", async () => {
    vi.stubEnv("VERCEL", "1")
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "")
    const res = await POST(post({ mode: "shop" }))
    expect(res.status).toBe(400)
    expect(h.set).not.toHaveBeenCalled()
  })
  it("production with Redis: mode 'shop' accepted", async () => {
    prod(true)
    const res = await POST(post({ mode: "shop" }))
    expect(res.status).toBe(200)
  })
  it("production without Redis: mode 'main' and other changes are still allowed", async () => {
    prod(false)
    h.set.mockResolvedValue(base)
    expect((await POST(post({ mode: "main" }))).status).toBe(200)
    expect((await POST(post({ visibility: { airtime: false } }))).status).toBe(200)
  })
  it("GET reports redis readiness alongside the existing env fields", async () => {
    prod(false)
    const res = await GET(new NextRequest("http://localhost/api/admin/ussd-hubtel/config"))
    const json = await res.json()
    expect(json.env).toEqual({ webhookSecret: true, relayUrl: true, relaySecret: true, redis: false })
    prod(true)
    const json2 = await (await GET(new NextRequest("http://localhost/api/admin/ussd-hubtel/config"))).json()
    expect(json2.env.redis).toBe(true)
  })
})
