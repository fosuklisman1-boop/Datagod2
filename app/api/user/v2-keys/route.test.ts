import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  recs: [] as Array<{ table: string; op: string; cols?: string }>,
  world: {} as any,
  createKey: vi.fn(async () => ({
    ok: true as const,
    key: "dg2_live_secret",
    row: { id: "k1", key_type: "standard", environment: "live", status: "pending", key_prefix: "p", created_at: "x" },
  })),
  smsAccount: vi.fn(async (_id: string): Promise<unknown> => ({ id: "sms-1" })),
}))

vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/roles/require-capability", () => ({
  requireCapability: async () => {
    const c = h.world.cap
    if (c === "yes") return null
    if (c === "error") return NextResponse.json({ error: "Couldn't check your access." }, { status: 503 })
    return NextResponse.json({ error: "This feature isn't available for your account." }, { status: 403 })
  },
}))
vi.mock("@/lib/sms/account-service", () => ({ getOrCreateAccountForUser: (id: string) => h.smsAccount(id) }))
vi.mock("@/lib/api-v2/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/store")>("@/lib/api-v2/store")
  return {
    ...actual,
    createKey: h.createKey,
    getAdminClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
      from(table: string) {
        const rec = { table, op: "select", cols: undefined as string | undefined }
        h.recs.push(rec)
        const w = h.world
        const result = () => {
          if (table === "users") return { data: { role: w.role, is_suspended: w.suspended ?? false }, error: null }
          if (table === "api_v2_config") return { data: { enabled: w.enabled ?? true, allowed_roles: w.allowed ?? ["dealer"] }, error: null }
          if (table === "api_v2_access_grants") {
            return w.grant === "error" ? { data: null, error: { message: "x" } } : { data: w.grant ? { user_id: "u1" } : null, error: null }
          }
          if (table === "sms_accounts") return { data: w.smsRow ?? null, error: null }
          if (table === "api_v2_keys") return { data: [], error: null }
          return { data: null, error: null }
        }
        const b: any = {
          select(c?: string) { rec.cols = c; return b },
          eq() { return b },
          in() { return b },
          order() { return b },
          maybeSingle() { return Promise.resolve(result()) },
          then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej) },
        }
        return b
      },
    }),
  }
})

import { GET, POST } from "./route"

const world = (over: any = {}) => {
  h.world = { role: "dealer", cap: "yes", grant: false, enabled: true, allowed: ["dealer"], suspended: false, ...over }
}
const grantReads = () => h.recs.filter((r) => r.table === "api_v2_access_grants").length
const get = () => GET({ headers: new Headers({ Authorization: "Bearer t" }) } as any)
const post = (body: any = { environment: "live", key_type: "standard" }) =>
  POST({ headers: new Headers({ Authorization: "Bearer t" }), json: async () => body } as any)

beforeEach(() => {
  h.recs.length = 0
  h.createKey.mockClear()
  h.smsAccount.mockClear()
  world()
})

describe("GET /api/user/v2-keys access", () => {
  it("an allowed role with the capability is ok and never reads a grant", async () => {
    const body = await (await get()).json()
    expect(body.access).toEqual({ canGenerate: true, reason: "ok" })
    expect(grantReads()).toBe(0)
  })
  it("a grant satisfies both the role and the capability", async () => {
    world({ role: "user", cap: "no", grant: true })
    expect((await (await get()).json()).access).toEqual({ canGenerate: true, reason: "ok" })
  })
  it("a role not allowed and no grant is role_not_allowed", async () => {
    world({ role: "user", grant: false })
    expect((await (await get()).json()).access).toEqual({ canGenerate: false, reason: "role_not_allowed" })
  })
  it("an allowed role lacking the capability with no grant is role_not_allowed", async () => {
    world({ cap: "no", grant: false })
    expect((await (await get()).json()).access).toEqual({ canGenerate: false, reason: "role_not_allowed" })
  })
  it("a grant read error is an error response (Retry), never allowed or not eligible", async () => {
    world({ role: "user", grant: "error" })
    const res = await get()
    expect(res.status).toBe(503)
    expect((await res.json()).access).toBeUndefined()
  })
  it("a capability read error is an error response", async () => {
    world({ cap: "error" })
    expect((await get()).status).toBe(503)
  })
  it("disabled and suspended answers never read the grant, so a grants outage cannot change them", async () => {
    world({ role: "user", grant: "error", enabled: false })
    expect((await (await get()).json()).access.reason).toBe("disabled")
    world({ role: "user", grant: "error", suspended: true })
    expect((await (await get()).json()).access.reason).toBe("suspended")
    expect(grantReads()).toBe(0)
  })
  it("a grant never beats disabled or suspended", async () => {
    world({ role: "user", cap: "no", grant: true, enabled: false })
    expect((await (await get()).json()).access.reason).toBe("disabled")
    world({ role: "user", cap: "no", grant: true, suspended: true })
    expect((await (await get()).json()).access.reason).toBe("suspended")
  })
})

describe("POST /api/user/v2-keys", () => {
  it("an allowed role with the capability creates a key and never reads a grant", async () => {
    expect((await post()).status).toBe(201)
    expect(h.createKey).toHaveBeenCalledTimes(1)
    expect(grantReads()).toBe(0)
  })
  it("a granted user with no capability and a role not allowed creates a key", async () => {
    world({ role: "user", cap: "no", grant: true })
    expect((await post()).status).toBe(201)
  })
  it("a role not allowed and no grant is 403", async () => {
    world({ role: "user", grant: false })
    expect((await post()).status).toBe(403)
    expect(h.createKey).not.toHaveBeenCalled()
  })
  it("no capability and no grant is 403 (the capability answer is not bypassed)", async () => {
    world({ cap: "no", grant: false })
    expect((await post()).status).toBe(403)
    expect(h.createKey).not.toHaveBeenCalled()
  })
  it("a grant read error is 503 and nothing is created", async () => {
    world({ role: "user", grant: "error" })
    expect((await post()).status).toBe(503)
    expect(h.createKey).not.toHaveBeenCalled()
  })
  it("a grant read error while the capability is missing is 503, not 403", async () => {
    world({ cap: "no", grant: "error" })
    expect((await post()).status).toBe(503)
  })
  it("a capability read error is 503", async () => {
    world({ cap: "error" })
    expect((await post()).status).toBe(503)
    expect(h.createKey).not.toHaveBeenCalled()
  })
  it("a grant never bypasses suspended, and a grants outage cannot turn it into 503", async () => {
    world({ role: "user", cap: "no", grant: "error", suspended: true })
    const res = await post()
    expect(res.status).toBe(403)
    expect(grantReads()).toBe(0)
  })
  it("a grant never bypasses disabled (503 either way, no grant read)", async () => {
    world({ role: "user", cap: "no", grant: true, enabled: false })
    expect((await post()).status).toBe(503)
    expect(grantReads()).toBe(0)
  })
  it("a grant plus an sms key with no SMS account is 403", async () => {
    world({ role: "user", cap: "no", grant: true })
    h.smsAccount.mockResolvedValueOnce(null)
    const res = await post({ environment: "live", key_type: "sms" })
    expect(res.status).toBe(403)
    expect(h.createKey).not.toHaveBeenCalled()
  })
  it("a grant plus an sms key with an SMS account creates it", async () => {
    world({ role: "user", cap: "no", grant: true })
    expect((await post({ environment: "live", key_type: "sms" })).status).toBe(201)
  })
  it("an invalid key_type is 400 before any grant read", async () => {
    world({ role: "user", grant: "error" })
    expect((await post({ environment: "live", key_type: "bogus" })).status).toBe(400)
    expect(grantReads()).toBe(0)
  })
})
