import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

type Op = { method: string; args: unknown[] }
const h = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  user: null as { id: string } | null,
  role: "user",
  suspension: "active" as string,
  shop: null as Record<string, unknown> | null,
  counts: { mine: 0, visitors: 0 },
  inserted: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  insertError: false,
  turnstileEnabled: false,
  turnstileValid: true,
  rateAllowed: true,
  rateDegraded: false,
  rateCalls: [] as unknown[][],
  mint: { ok: true, token: "tok_abc", warnings: [] } as Record<string, unknown>,
  mintCalls: [] as Record<string, unknown>[],
  countOps: [] as unknown[][],
  updateError: false,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (table: string) => {
      const ops: Op[] = []
      const b: any = {}
      let idx = -1
      for (const m of ["select", "eq", "in", "gte", "or", "is", "update", "insert"]) {
        b[m] = (...args: unknown[]) => {
          ops.push({ method: m, args })
          if (m === "insert") { idx = h.inserted.length; h.inserted.push({ ...(args[0] as Record<string, unknown>) }) }
          if (m === "update") h.updates.push(args[0] as Record<string, unknown>)
          return b
        }
      }
      const result = () => {
        if (table === "ai_voice_calls") {
          const sel = ops.find((o) => o.method === "select")
          if (sel && (sel.args[1] as any)?.head) {
            const isVisitor = ops.some((o) => o.method === "in")
            h.countOps.push(ops.map((o) => [o.method, ...o.args]))
            const own = h.inserted.filter((r) => r.end_reason !== "cap_exceeded")
            return isVisitor
              ? { count: h.counts.visitors + own.filter((r) => !r.user_id).length, error: null }
              : { count: h.counts.mine + own.length, error: null }
          }
        }
        if (ops.some((o) => o.method === "update")) {
          const patch = ops.find((o) => o.method === "update")!.args[0] as Record<string, unknown>
          const idEq = ops.find((o) => o.method === "eq" && o.args[0] === "id")
          const m = /^call-(\d+)$/.exec(String(idEq?.args[1]))
          if (m && h.inserted[Number(m[1])]) Object.assign(h.inserted[Number(m[1])], patch)
          return { data: null, error: h.updateError ? { message: "x" } : null }
        }
        return { data: null, error: null }
      }
      b.single = async () => (table === "ai_voice_calls" ? (h.insertError ? { data: null, error: { message: "x" } } : { data: { id: `call-${idx}` }, error: null }) : { data: null, error: null })
      b.maybeSingle = async () => {
        if (table === "users") {
          const sel = ops.find((o) => o.method === "select")
          return { data: String(sel?.args[0]).includes("role") ? { role: h.role } : { is_suspended: false }, error: null }
        }
        if (table === "user_shops") return { data: h.shop, error: null }
        if (table === "admin_settings") return { data: { value: h.config }, error: null }
        return { data: null, error: null }
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res)
      return b
    },
  }),
}))
vi.mock("@/lib/auth/suspension", () => ({ suspensionStatus: async () => h.suspension }))
vi.mock("@/lib/turnstile", () => ({
  isTurnstileEnabled: async () => h.turnstileEnabled,
  verifyTurnstileToken: async () => ({ valid: h.turnstileValid }),
  getRequestIp: () => "1.2.3.4",
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async (...a: unknown[]) => { h.rateCalls.push(a.slice(1)); return { allowed: h.rateAllowed, remaining: 1, resetAt: 0, degraded: h.rateDegraded } } }))
vi.mock("@/lib/ai-voice/nuance", () => ({
  mintNuanceToken: async (i: Record<string, unknown>) => { h.mintCalls.push(i); return h.mint },
}))

import { POST } from "./route"
import { resetAIConfigCache } from "@/lib/ai-console/load-config"

const ON = (extra: Record<string, unknown> = {}) => ({
  voice: { enabled: true, audiences: { public: true, storefront: true, dashboard: true, admin: true }, maxCallSeconds: 240, ...extra },
})
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/ai/voice/token", { method: "POST", body: JSON.stringify(body), headers })
const authed = { authorization: "Bearer jwt" }

beforeEach(() => {
  resetAIConfigCache()
  Object.assign(h, {
    config: ON(), user: null, role: "user", suspension: "active", shop: null, counts: { mine: 0, visitors: 0 },
    inserted: [], updates: [], insertError: false, turnstileEnabled: false, turnstileValid: true, rateAllowed: true, rateDegraded: false, rateCalls: [], countOps: [], updateError: false,
    mint: { ok: true, token: "tok_abc", warnings: [] }, mintCalls: [],
  })
  process.env.NUANCE_DEVICE_SALT = "salt"
})

describe("POST /api/ai/voice/token", () => {
  it("bad body -> 400", async () => {
    const r = new NextRequest("http://localhost/x", { method: "POST", body: "nope" })
    expect((await POST(r)).status).toBe(400)
    expect((await POST(req({ context: "bogus", mode: "voice" }))).status).toBe(400)
    expect((await POST(req({ context: "home", mode: "tv" }))).status).toBe(400)
  })

  it("rate limited -> 429", async () => {
    h.rateAllowed = false
    expect((await POST(req({ context: "home", mode: "voice" }))).status).toBe(429)
  })

  it("master off -> disabled, no mint, no row", async () => {
    h.config = { voice: { enabled: false } }
    const res = await POST(req({ context: "home", mode: "voice" }))
    expect(await res.json()).toEqual({ fallback: "text", reason: "disabled" })
    expect(h.mintCalls).toHaveLength(0)
    expect(h.inserted).toHaveLength(0)
  })

  it("dashboard without a JWT -> 401", async () => {
    expect((await POST(req({ context: "dashboard", mode: "voice" }))).status).toBe(401)
  })

  it("admin context with a non-admin JWT -> 403", async () => {
    h.user = { id: "u1" }
    expect((await POST(req({ context: "admin", mode: "voice" }, authed))).status).toBe(403)
    expect(h.mintCalls).toHaveLength(0)
  })

  it("suspended -> suspended; unknown -> unavailable", async () => {
    h.user = { id: "u1" }
    h.suspension = "suspended"
    expect(await (await POST(req({ context: "dashboard", mode: "voice" }, authed))).json()).toEqual({ fallback: "text", reason: "suspended" })
    h.suspension = "unknown"
    expect(await (await POST(req({ context: "dashboard", mode: "voice" }, authed))).json()).toEqual({ fallback: "text", reason: "unavailable" })
    expect(h.mintCalls).toHaveLength(0)
  })

  it("home with a bad Turnstile (enabled) -> bot", async () => {
    h.turnstileEnabled = true
    h.turnstileValid = false
    const res = await POST(req({ context: "home", mode: "voice", turnstileToken: "t" }))
    expect(await res.json()).toEqual({ fallback: "text", reason: "bot" })
    expect(h.inserted).toHaveLength(0)
  })

  it("storefront inactive or missing shop -> shop_unavailable", async () => {
    expect(await (await POST(req({ context: "storefront", mode: "voice", shopSlug: "nope" }))).json()).toEqual({ fallback: "text", reason: "shop_unavailable" })
    h.shop = { id: "s1", is_active: false }
    expect(await (await POST(req({ context: "storefront", mode: "voice", shopSlug: "x" }))).json()).toEqual({ fallback: "text", reason: "shop_unavailable" })
    h.shop = { id: "s1", is_active: true, is_blocked: true }
    expect(await (await POST(req({ context: "storefront", mode: "voice", shopSlug: "x" }))).json()).toEqual({ fallback: "text", reason: "shop_unavailable" })
    expect(h.mintCalls).toHaveLength(0)
  })

  it("dashboard user at the daily cap -> daily_cap", async () => {
    h.user = { id: "u1" }
    h.counts.mine = 5
    expect(await (await POST(req({ context: "dashboard", mode: "voice" }, authed))).json()).toEqual({ fallback: "text", reason: "daily_cap" })
    expect(h.mintCalls).toHaveLength(0)
    expect(h.inserted[0].end_reason).toBe("cap_exceeded")
  })

  it("visitor total reached: home -> visitor_cap, dashboard user still gets a token", async () => {
    h.counts.visitors = 30
    expect(await (await POST(req({ context: "home", mode: "voice" }))).json()).toEqual({ fallback: "text", reason: "visitor_cap" })
    h.user = { id: "u1" }
    const ok = await (await POST(req({ context: "dashboard", mode: "voice" }, authed))).json()
    expect(ok.token).toBe("tok_abc")
  })

  it("success inserts one row before minting and returns the settings max", async () => {
    h.user = { id: "u1" }
    const res = await POST(req({ context: "dashboard", mode: "video" }, authed))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ token: "tok_abc", callId: "call-0", maxSeconds: 240 })
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted[0]).toMatchObject({ user_id: "u1", context: "dashboard", mode: "video", persona_id: "sam", max_seconds: 240 })
    expect(h.inserted[0].device_hash).toBeUndefined()
    expect(h.mintCalls[0]).toMatchObject({ camera: true, endUserId: "u_u1", personaId: "sam" })
  })

  it("credits refusal -> reason credits and the row still exists with mint_credits", async () => {
    h.user = { id: "u1" }
    h.mint = { ok: false, reason: "credits", status: 429, code: "credits_spent" }
    const res = await POST(req({ context: "dashboard", mode: "voice" }, authed))
    expect(await res.json()).toEqual({ fallback: "text", reason: "credits" })
    expect(h.inserted).toHaveLength(1)
    expect(h.updates[0]).toMatchObject({ end_reason: "mint_credits" })
    expect(h.inserted[0].end_reason).toBe("mint_credits")
  })

  it("first home call sets dg_vdid and stores the device hash", async () => {
    const res = await POST(req({ context: "home", mode: "voice" }))
    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie).toMatch(/dg_vdid=[a-f0-9]{32}/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=lax/i)
    expect(h.inserted[0].user_id).toBeUndefined()
    expect(String(h.inserted[0].device_hash)).toMatch(/^[a-f0-9]{32}$/)
    expect(h.mintCalls[0].endUserId).toBe(`d_${h.inserted[0].device_hash}`)
  })

  it("an existing valid cookie is reused (no new Set-Cookie)", async () => {
    const id = "a".repeat(32)
    const res = await POST(req({ context: "home", mode: "voice" }, { cookie: `dg_vdid=${id}` }))
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("storefront with an active shop records shop_id", async () => {
    h.shop = { id: "s1", is_active: true, is_blocked: false }
    await POST(req({ context: "storefront", mode: "voice", shopSlug: "good" }))
    expect(h.inserted[0]).toMatchObject({ context: "storefront", shop_id: "s1" })
  })
})

describe("fix round 1: paid-call protection", () => {
  it("cookieless visitors from one IP share one rate-limit bucket, with pgFallback", async () => {
    await POST(req({ context: "home", mode: "voice" }))
    await POST(req({ context: "home", mode: "voice" }))
    expect(h.rateCalls).toHaveLength(2)
    expect(h.rateCalls[0][3]).toBe("1.2.3.4")
    expect(h.rateCalls[1][3]).toBe("1.2.3.4")
    expect(h.rateCalls[0][4]).toEqual({ pgFallback: true })
  })

  it("signed-in users are keyed by user id", async () => {
    h.user = { id: "u1" }
    await POST(req({ context: "dashboard", mode: "voice" }, authed))
    expect(h.rateCalls[0][3]).toBe("u1")
  })

  it("degraded rate limiter -> unavailable, nothing minted or inserted", async () => {
    h.rateDegraded = true
    expect(await (await POST(req({ context: "home", mode: "voice" }))).json()).toEqual({ fallback: "text", reason: "unavailable" })
    expect(h.mintCalls).toHaveLength(0)
    expect(h.inserted).toHaveLength(0)
  })

  it("parallel requests at 29/30 visitors: at most one mints", async () => {
    h.counts.visitors = 29
    const ids = ["c".repeat(32), "d".repeat(32), "e".repeat(32)]
    const res = await Promise.all(ids.map((id) => POST(req({ context: "home", mode: "voice" }, { cookie: `dg_vdid=${id}` }))))
    const bodies = await Promise.all(res.map((r) => r.json()))
    expect(h.mintCalls.length).toBeLessThanOrEqual(1)
    expect(bodies.filter((b) => b.token).length).toBeLessThanOrEqual(1)
    expect(h.inserted.filter((r) => r.end_reason === "cap_exceeded").length).toBeGreaterThanOrEqual(2)
  })

  it("the cap counts exclude cap_exceeded rows", async () => {
    h.user = { id: "u1" }
    await POST(req({ context: "dashboard", mode: "voice" }, authed))
    const ops = h.countOps[0].map((o) => JSON.stringify(o))
    expect(ops.join("|")).toContain("cap_exceeded")
  })

  it("signed-in user on home with 30 visitor rows still gets a token; visitor count skipped", async () => {
    h.user = { id: "u1" }
    h.counts.visitors = 30
    const body = await (await POST(req({ context: "home", mode: "voice" }, authed))).json()
    expect(body.token).toBe("tok_abc")
  })

  it("visitor total counts only anonymous rows", async () => {
    await POST(req({ context: "home", mode: "voice" }))
    const visitorOp = h.countOps.find((ops) => ops.some((o) => (o as unknown[])[0] === "in"))!
    expect(visitorOp.some((o) => (o as unknown[])[0] === "is" && (o as unknown[])[1] === "user_id" && (o as unknown[])[2] === null)).toBe(true)
  })

  it("a failed mint-failure update is logged without details", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    h.user = { id: "u1" }
    h.updateError = true
    h.mint = { ok: false, reason: "busy", status: 409 }
    await POST(req({ context: "dashboard", mode: "voice" }, authed))
    expect(err).toHaveBeenCalledWith("[voice] call row update failed")
    err.mockRestore()
  })
})