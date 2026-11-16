import { GET, POST } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    updates: 0,
    inserts: 0,
    cfg: null as { sunsetAt: Date | null; exemptUserIds: string[] } | null,
  }
  const fake = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
      update: () => {
        state.updates++
        return { eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }
      },
      insert: () => {
        state.inserts++
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: "k1", name: "Live key", key_prefix: "dg_live_x", environment: "live", created_at: "t" }, error: null }),
          }),
        }
      },
    }),
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/api-v1/retirement", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-v1/retirement")>()),
  getV1RetirementConfig: async () => h.state.cfg,
}))

function req(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/user/keys", {
    method,
    headers: { Authorization: "Bearer t", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeEach(() => {
  h.state.updates = 0
  h.state.inserts = 0
  h.state.cfg = null
})

describe("POST /api/user/keys", () => {
  it("returns 410 and neither revokes nor inserts when a sunset is set", async () => {
    h.state.cfg = { sunsetAt: new Date("2026-11-26T00:00:00Z"), exemptUserIds: [] }
    const res = await POST(req("POST", { environment: "live" }))
    expect(res.status).toBe(410)
    const json = await res.json()
    expect(json.error).toBe(
      "API v1 key creation has ended. v1 will be retired on 26 Nov 2026, 00:00 GMT. Create a v2 key on the Developer page: https://www.datagod.store/developers"
    )
    expect(h.state.updates).toBe(0)
    expect(h.state.inserts).toBe(0)
  })

  it("refuses exempt users too", async () => {
    h.state.cfg = { sunsetAt: new Date("2026-11-26T00:00:00Z"), exemptUserIds: ["user-1"] }
    const res = await POST(req("POST", { environment: "live" }))
    expect(res.status).toBe(410)
    expect(h.state.updates).toBe(0)
  })

  it("creates as today when config is null", async () => {
    const res = await POST(req("POST", { environment: "live" }))
    expect(res.status).toBe(201)
    expect(h.state.updates).toBe(1)
    expect(h.state.inserts).toBe(1)
  })

  it("creates as today when no sunset is scheduled", async () => {
    h.state.cfg = { sunsetAt: null, exemptUserIds: [] }
    const res = await POST(req("POST", { environment: "live" }))
    expect(res.status).toBe(201)
  })
})

describe("GET /api/user/keys", () => {
  it("includes retirement info for a non-exempt user", async () => {
    h.state.cfg = { sunsetAt: new Date("2026-11-26T00:00:00Z"), exemptUserIds: ["other"] }
    const json = await (await GET(req("GET"))).json()
    expect(json.retirement).toEqual({ sunset_at: "2026-11-26T00:00:00.000Z", exempt: false })
  })

  it("flags exempt users", async () => {
    h.state.cfg = { sunsetAt: new Date("2026-11-26T00:00:00Z"), exemptUserIds: ["user-1"] }
    const json = await (await GET(req("GET"))).json()
    expect(json.retirement.exempt).toBe(true)
  })

  it("reports null sunset when config is null", async () => {
    const json = await (await GET(req("GET"))).json()
    expect(json.retirement).toEqual({ sunset_at: null, exempt: false })
  })
})
