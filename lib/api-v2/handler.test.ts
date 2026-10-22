import { describe, it, expect, vi } from "vitest"
import { runV2, type V2Context } from "./handler"
import { generateV2Key, hashV2Key } from "./keys"

const OPTS = { requiredType: "standard" as const, group: "status" as const, endpoint: "/api/v2/account/role" }

function makeDeps(over: any = {}) {
  const row = {
    id: "key-1",
    user_id: "user-1",
    key_type: "standard",
    environment: "live",
    status: "active",
    name: "n",
    key_prefix: "p",
    rate_limits: null,
    last_used_at: null,
    created_at: "x",
    ...(over.row ?? {}),
  }
  const store = {
    findKeyByHash: vi.fn(async () => (over.noKey ? null : row)),
    getUserForKey: vi.fn(async () =>
      over.noUser ? null : { id: "user-1", role: over.role ?? "dealer", first_name: "Ama", suspended: over.suspended ?? false }
    ),
    getConfig: vi.fn(async () => ({
      enabled: over.enabled ?? true,
      allowed_roles: over.allowedRoles ?? ["dealer"],
    })),
    touchLastUsed: vi.fn(async () => {}),
    logRequest: vi.fn(async () => {}),
  }
  const rateLimit = vi.fn(async () => ({ allowed: over.allowed ?? true, remaining: 1, resetAt: 0 }))
  return { store, rateLimit, now: () => new Date("2026-01-01T00:00:00Z") }
}

function input(key?: string) {
  const h = new Headers()
  if (key) h.set("authorization", `Bearer ${key}`)
  return { headers: h, method: "GET", request: { headers: h } as any }
}

const validKey = () => generateV2Key("standard", "live").key
const ok = async (_r: any, ctx: V2Context) => ({ status: 200, data: { env: ctx.environment } })

describe("runV2", () => {
  it("401 when no key header", async () => {
    const r = await runV2(makeDeps(), OPTS, ok, input())
    expect(r.status).toBe(401)
    expect(r.body).toMatchObject({ success: false, error: { code: 401 } })
  })

  it("401 for v1-style key and never queries the store", async () => {
    const deps = makeDeps()
    const r = await runV2(deps, OPTS, ok, input("dg_live_" + "a".repeat(40)))
    expect(r.status).toBe(401)
    expect(deps.store.findKeyByHash).not.toHaveBeenCalled()
  })

  it("401 for unknown hash, and does not log", async () => {
    const deps = makeDeps({ noKey: true })
    const r = await runV2(deps, OPTS, ok, input(validKey()))
    expect(r.status).toBe(401)
    expect(deps.store.logRequest).not.toHaveBeenCalled()
  })

  it("403 for pending key", async () => {
    const r = await runV2(makeDeps({ row: { status: "pending" } }), OPTS, ok, input(validKey()))
    expect(r.status).toBe(403)
  })

  it("403 for standard key on commission endpoint", async () => {
    const r = await runV2(makeDeps(), { ...OPTS, requiredType: "commission" }, ok, input(validKey()))
    expect(r.status).toBe(403)
  })

  it("503 when config disabled", async () => {
    const r = await runV2(makeDeps({ enabled: false }), OPTS, ok, input(validKey()))
    expect(r.status).toBe(503)
  })

  it("403 for a suspended account, and the handler never runs", async () => {
    const handler = vi.fn(ok)
    const r = await runV2(makeDeps({ suspended: true }), OPTS, handler, input(validKey()))
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ success: false, error: { code: 403, message: "This account is suspended" } })
    expect(handler).not.toHaveBeenCalled()
  })

  it("503 beats suspension when config is disabled", async () => {
    const r = await runV2(makeDeps({ suspended: true, enabled: false }), OPTS, ok, input(validKey()))
    expect(r.status).toBe(503)
  })

  it("401 when the key's user row is missing", async () => {
    const deps = makeDeps({ noUser: true })
    const r = await runV2(deps, OPTS, ok, input(validKey()))
    expect(r.status).toBe(401)
    expect(r.body).toMatchObject({ success: false, error: { code: 401 } })
  })

  it("403 for a revoked key", async () => {
    const r = await runV2(makeDeps({ row: { status: "revoked" } }), OPTS, ok, input(validKey()))
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ error: { code: 403, message: "This API key has been revoked" } })
  })

  it("looks the key up by hashV2Key(rawKey), never by the raw key", async () => {
    const deps = makeDeps()
    const key = validKey()
    await runV2(deps, OPTS, ok, input(key))
    expect(deps.store.findKeyByHash).toHaveBeenCalledTimes(1)
    const arg = (deps.store.findKeyByHash.mock.calls as any)[0][0]
    expect(arg).toBe(hashV2Key(key))
    expect(arg).not.toBe(key)
    expect(arg).not.toContain(key)
  })

  it("403 when role not allowed", async () => {
    const r = await runV2(makeDeps({ role: "customer" }), OPTS, ok, input(validKey()))
    expect(r.status).toBe(403)
  })

  it("429 when rate limited", async () => {
    const deps = makeDeps({ allowed: false })
    const handler = vi.fn(ok)
    const r = await runV2(deps, OPTS, handler, input(validKey()))
    expect(r.status).toBe(429)
    expect(r.body).toMatchObject({ error: { code: 429 } })
    expect(handler).not.toHaveBeenCalled()
    expect((deps.rateLimit.mock.calls as any)[0][1]).toBe("v2_standard_live_status")
  })

  it("over-limit requests get 429 before any user/config lookup or DB write", async () => {
    const deps = makeDeps({ allowed: false })
    const r = await runV2(deps, OPTS, ok, input(validKey()))
    expect(r.status).toBe(429)
    expect(deps.store.getUserForKey).not.toHaveBeenCalled()
    expect(deps.store.getConfig).not.toHaveBeenCalled()
    expect(deps.store.logRequest).not.toHaveBeenCalled()
    expect(deps.store.touchLastUsed).not.toHaveBeenCalled()
  })

  it("a revoked key over its limit gets 429 and nothing is logged or touched", async () => {
    const deps = makeDeps({ row: { status: "revoked" }, allowed: false })
    const r = await runV2(deps, OPTS, ok, input(validKey()))
    expect(r.status).toBe(429)
    expect(deps.store.logRequest).not.toHaveBeenCalled()
    expect(deps.store.touchLastUsed).not.toHaveBeenCalled()
  })

  it("a revoked key within its limit still gets 403 and consumes the bucket", async () => {
    const deps = makeDeps({ row: { status: "revoked" } })
    const r = await runV2(deps, OPTS, ok, input(validKey()))
    expect(r.status).toBe(403)
    expect(deps.rateLimit).toHaveBeenCalledTimes(1)
  })

  it("denied outcomes (503, suspended, pending, wrong type, role) all consume the rate-limit bucket", async () => {
    const cases: Array<[any, any]> = [
      [{ enabled: false }, OPTS],
      [{ suspended: true }, OPTS],
      [{ row: { status: "pending" } }, OPTS],
      [{}, { ...OPTS, requiredType: "commission" }],
      [{ role: "customer" }, OPTS],
    ]
    for (const [over, opts] of cases) {
      const deps = makeDeps(over)
      const r = await runV2(deps, opts, ok, input(validKey()))
      expect(r.status).not.toBe(200)
      expect(deps.rateLimit).toHaveBeenCalledTimes(1)
    }
  })

  it("test and live keys use different rate-limit buckets", async () => {
    const live = makeDeps()
    await runV2(live, OPTS, ok, input(validKey()))
    const test = makeDeps({ row: { environment: "test" } })
    await runV2(test, OPTS, ok, input(generateV2Key("standard", "test").key))
    const liveName = (live.rateLimit.mock.calls as any)[0][1]
    const testName = (test.rateLimit.mock.calls as any)[0][1]
    expect(liveName).toBe("v2_standard_live_status")
    expect(testName).toBe("v2_standard_test_status")
    expect(liveName).not.toBe(testName)
  })

  it("rate limiter gets per-key override, group name, window and owner id", async () => {
    const deps = makeDeps({ row: { rate_limits: { status: 7 } } })
    await runV2(deps, OPTS, ok, input(validKey()))
    const c = (deps.rateLimit.mock.calls as any)[0]
    expect(c[1]).toBe("v2_standard_live_status")
    expect(c[2]).toBe(7)
    expect(c[3]).toBe(60000)
    expect(c[4]).toBe("user-1")
  })

  it("rate limiter uses the group default when no overrides", async () => {
    const deps = makeDeps()
    await runV2(deps, OPTS, ok, input(validKey()))
    expect((deps.rateLimit.mock.calls as any)[0][2]).toBe(30)
  })

  it("500 with generic body when handler throws", async () => {
    const boom = async () => {
      throw new Error("SECRET-DB-DETAIL")
    }
    const r = await runV2(makeDeps(), OPTS, boom, input(validKey()))
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toContain("SECRET-DB-DETAIL")
  })

  it("maps handler error results to the error envelope", async () => {
    const h = async () => ({ status: 500, error: { status: 500 as const, message: "Nope" } })
    const r = await runV2(makeDeps(), OPTS, h, input(validKey()))
    expect(r.status).toBe(500)
    expect(r.body).toMatchObject({ success: false, error: { code: 500, message: "Nope" } })
  })

  it("a non-2xx handler status without an error becomes a generic 500, never a success body", async () => {
    for (const status of [404, 302, 500, 199]) {
      const deps = makeDeps()
      const h = async () => ({ status, data: { leaked: "SECRET-DATA" } })
      const r = await runV2(deps, OPTS, h, input(validKey()))
      expect(r.status).toBe(500)
      expect(r.body).toMatchObject({ success: false, error: { code: 500, message: "Internal server error" } })
      expect(JSON.stringify(r.body)).not.toContain("SECRET-DATA")
    }
  })

  it("2xx handler statuses keep the success envelope", async () => {
    const h = async () => ({ status: 201, data: { x: 1 } })
    const r = await runV2(makeDeps(), OPTS, h, input(validKey()))
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ success: true, data: { x: 1 } })
  })

  it("happy path returns envelope and logs once without payload", async () => {
    const deps = makeDeps()
    const r = await runV2(deps, OPTS, ok, input(validKey()))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, data: { env: "live" }, meta: { version: "2" } })
    expect(deps.store.logRequest).toHaveBeenCalledTimes(1)
    const p = (deps.store.logRequest.mock.calls as any)[0][0]
    expect(p.keyId).toBe("key-1")
    expect(p.statusCode).toBe(200)
    expect(Object.keys(p)).not.toContain("body")
    expect(Object.keys(p)).not.toContain("payload")
    expect(deps.store.touchLastUsed).toHaveBeenCalledWith("key-1")
  })

  it("passes test environment to handler", async () => {
    let seen = ""
    const h = async (_r: any, ctx: V2Context) => {
      seen = ctx.environment
      return { status: 200, data: {} }
    }
    await runV2(makeDeps({ row: { environment: "test" } }), OPTS, h, input(generateV2Key("standard", "test").key))
    expect(seen).toBe("test")
  })
})
