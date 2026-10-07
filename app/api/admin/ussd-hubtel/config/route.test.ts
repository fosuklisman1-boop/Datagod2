import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  auth: { isAdmin: true, userId: "admin-1" } as any,
  get: vi.fn(),
  set: vi.fn(),
  envReady: vi.fn(),
  audit: [] as unknown[],
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
// validateWelcome / DEFAULT_WELCOME stay REAL (pure); only the DB-touching functions are faked.
vi.mock("@/lib/ussd-hubtel/config", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/ussd-hubtel/config")>()),
  getHubtelUssdConfig: (...a: any[]) => h.get(...a),
  setHubtelUssdConfig: (...a: any[]) => h.set(...a),
  hubtelEnvReady: (...a: any[]) => h.envReady(...a),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: (rows: unknown) => { h.audit.push(rows); return Promise.resolve({ error: null }) } }) }),
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
  h.audit = []
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

describe("POST /api/admin/ussd-hubtel/config: welcome message", () => {
  const getReq = () => new NextRequest("http://localhost/api/admin/ussd-hubtel/config")

  it("saves a valid (trimmed) welcome, audits old/new, and GET returns it", async () => {
    const before = { ...base, welcome: "Welcome to Clingshub" }
    const after = { ...base, welcome: "Akwaaba to Ama Data" }
    h.get.mockResolvedValueOnce(before)
    h.set.mockResolvedValue(after)
    const res = await POST(post({ welcome: "  Akwaaba to Ama Data  " }))
    expect(res.status).toBe(200)
    expect(h.set.mock.calls[0][1]).toMatchObject({ welcome: "Akwaaba to Ama Data" })
    expect((await res.json()).config.welcome).toBe("Akwaaba to Ama Data")
    await new Promise(r => setTimeout(r, 0))
    expect(h.audit[0]).toEqual([expect.objectContaining({
      action: "hubtel_ussd_config_update",
      old_value: expect.objectContaining({ welcome: "Welcome to Clingshub" }),
      new_value: expect.objectContaining({ welcome: "Akwaaba to Ama Data" }),
    })])
    h.get.mockResolvedValue(after)
    const g = await GET(getReq())
    expect((await g.json()).config.welcome).toBe("Akwaaba to Ama Data")
  })
  it("a body without welcome does not touch it (patch has no welcome)", async () => {
    await POST(post({ mode: "shop" }))
    expect(h.set.mock.calls[0][1].welcome).toBeUndefined()
  })
  const bad: Array<[string, unknown, RegExp]> = [
    ["non-ASCII accent", "Café Data", /special character/i],
    ["emoji", "Hi \u{1F31F}", /special character/i],
    ["curly quotes", "“Hi”", /special character/i],
    ["too long", "x".repeat(61), /60/],
    ["newline", "Hello\nWorld", /single line/i],
    ["non-string", 42, /string/i],
    ["null", null, /string/i],
  ]
  for (const [name, welcome, msg] of bad) {
    it(`rejects ${name} with 400 and writes nothing`, async () => {
      const res = await POST(post({ welcome, enabled: true, mode: "shop" }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(msg)
      expect(h.set).not.toHaveBeenCalled()
      expect(h.audit).toEqual([])
    })
  }
  it("an empty / whitespace welcome clears the custom override (welcome: null)", async () => {
    for (const welcome of ["", "   "]) {
      h.set.mockClear()
      const res = await POST(post({ welcome }))
      expect(res.status, JSON.stringify(welcome)).toBe(200)
      expect(h.set.mock.calls[0][1]).toMatchObject({ welcome: null })
    }
  })
  it("a rate-limited admin posting a welcome gets the 429 and nothing is written", async () => {
    const { NextResponse } = await import("next/server")
    h.auth = { isAdmin: true, userId: "admin-1", errorResponse: NextResponse.json({ error: "Too many requests" }, { status: 429 }) }
    const res = await POST(post({ welcome: "Hello" }))
    expect(res.status).toBe(429)
    expect(h.set).not.toHaveBeenCalled()
  })
})

describe("POST /api/admin/ussd-hubtel/config: brand name", () => {
  const getReq = () => new NextRequest("http://localhost/api/admin/ussd-hubtel/config")
  const cfg = (brandName: string, welcome = `Welcome to ${brandName}`, welcomeCustom = false) =>
    ({ ...base, brandName, welcome, welcomeCustom })

  it("saves a valid (trimmed) brand, audits old/new, and GET returns brandName + effective welcome + welcomeCustom", async () => {
    h.get.mockResolvedValueOnce(cfg("Clingshub"))
    h.set.mockResolvedValue(cfg("Ama Data"))
    const res = await POST(post({ brandName: "  Ama Data " }))
    expect(res.status).toBe(200)
    expect(h.set.mock.calls[0][1]).toMatchObject({ brandName: "Ama Data" })
    expect(h.set.mock.calls[0][1].welcome).toBeUndefined()
    expect((await res.json()).config).toMatchObject({ brandName: "Ama Data", welcome: "Welcome to Ama Data", welcomeCustom: false })
    await new Promise(r => setTimeout(r, 0))
    expect(h.audit[0]).toEqual([expect.objectContaining({
      old_value: expect.objectContaining({ brandName: "Clingshub" }),
      new_value: expect.objectContaining({ brandName: "Ama Data" }),
    })])
    h.get.mockResolvedValue(cfg("Ama Data", "Akwaaba!", true))
    const g = await (await GET(getReq())).json()
    expect(g.config).toMatchObject({ brandName: "Ama Data", welcome: "Akwaaba!", welcomeCustom: true })
  })
  const bad: Array<[string, unknown, RegExp]> = [
    ["non-ASCII accent", "Café", /special character/i],
    ["emoji", "Ama \u{1F31F}", /special character/i],
    ["too long", "x".repeat(31), /30/],
    ["newline", "Ama\nData", /single line/i],
    ["non-string", 42, /string/i],
    ["null", null, /string/i],
  ]
  for (const [name, brandName, msg] of bad) {
    it(`rejects ${name} brand with 400 and writes nothing`, async () => {
      const res = await POST(post({ brandName, mode: "shop" }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(msg)
      expect(h.set).not.toHaveBeenCalled()
      expect(h.get).not.toHaveBeenCalled()
      expect(h.audit).toEqual([])
    })
  }
  it("an empty / whitespace brand resets to the default 'Clingshub'", async () => {
    for (const brandName of ["", "  "]) {
      h.set.mockClear()
      const res = await POST(post({ brandName }))
      expect(res.status).toBe(200)
      expect(h.set.mock.calls[0][1]).toMatchObject({ brandName: "Clingshub" })
    }
  })
  it("brand + welcome in one request are saved together", async () => {
    const res = await POST(post({ brandName: "Ama Data", welcome: "Akwaaba!" }))
    expect(res.status).toBe(200)
    expect(h.set).toHaveBeenCalledTimes(1)
    expect(h.set.mock.calls[0][1]).toMatchObject({ brandName: "Ama Data", welcome: "Akwaaba!" })
  })
  it("invalid brand + valid welcome: 400, nothing written", async () => {
    const res = await POST(post({ brandName: "Café", welcome: "Akwaaba!" }))
    expect(res.status).toBe(400)
    expect(h.set).not.toHaveBeenCalled()
    expect(h.audit).toEqual([])
  })
  it("valid brand + invalid welcome: 400, nothing written", async () => {
    const res = await POST(post({ brandName: "Ama Data", welcome: "x".repeat(61) }))
    expect(res.status).toBe(400)
    expect(h.set).not.toHaveBeenCalled()
  })
  it("a rate-limited admin posting a brand gets the 429 and nothing is written", async () => {
    const { NextResponse } = await import("next/server")
    h.auth = { isAdmin: true, userId: "admin-1", errorResponse: NextResponse.json({ error: "Too many requests" }, { status: 429 }) }
    const res = await POST(post({ brandName: "Ama Data" }))
    expect(res.status).toBe(429)
    expect(h.set).not.toHaveBeenCalled()
  })
})
