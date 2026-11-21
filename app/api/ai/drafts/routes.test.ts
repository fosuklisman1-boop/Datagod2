import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  user: { id: "user-1", user_metadata: {} as Record<string, unknown> } as { id: string; user_metadata: Record<string, unknown> } | null,
  role: "user" as string | null,
  roleError: null as unknown,
  getUser: vi.fn(),
  allowed: true,
  confirmDraft: vi.fn(),
  recheckDraft: vi.fn(),
  getOwnDraft: vi.fn(),
  cancelDraft: vi.fn(),
  expireIfDue: vi.fn(async (_db: unknown, d: unknown) => d),
  recoverStaleExecuting: vi.fn(async (_db: unknown, d: unknown) => d),
  applyRateLimit: vi.fn(),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async (jwt: string) => {
        h.getUser(jwt)
        return h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad" } }
      },
    },
    from: (table: string) => {
      if (table !== "users") throw new Error("unexpected table " + table)
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: h.role ? { role: h.role } : null, error: h.roleError }) }),
        }),
      }
    },
  }),
}))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: (...a: unknown[]) => {
    h.applyRateLimit(...a)
    return Promise.resolve({ allowed: h.allowed, remaining: 0, resetAt: 0 })
  },
}))
vi.mock("@/lib/ai-drafts/confirm", () => ({ confirmDraft: h.confirmDraft, recheckDraft: h.recheckDraft }))
vi.mock("@/lib/ai-drafts/repo", () => ({
  getOwnDraft: h.getOwnDraft,
  cancelDraft: h.cancelDraft,
  expireIfDue: h.expireIfDue,
  recoverStaleExecuting: h.recoverStaleExecuting,
}))

import { GET } from "./[id]/route"
import { POST as confirm } from "./[id]/confirm/route"
import { POST as recheck } from "./[id]/recheck/route"
import { POST as cancel } from "./[id]/cancel/route"

const ID = "11111111-1111-4111-8111-111111111111"
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) })
const req = (method: string, auth: string | null = "Bearer tok") =>
  new NextRequest(`http://localhost/api/ai/drafts/${ID}`, { method, headers: auth ? { authorization: auth } : {} })

const draft = (over: Record<string, unknown> = {}) => ({
  id: ID,
  user_id: "user-1",
  status: "pending",
  action: "wallet_order",
  outcome: null,
  display: { title: "x" },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.user = { id: "user-1", user_metadata: {} }
  h.role = "user"
  h.roleError = null
  h.allowed = true
  h.expireIfDue.mockImplementation(async (_db, d) => d)
  h.recoverStaleExecuting.mockImplementation(async (_db, d) => d)
})

describe("auth", () => {
  it("no_auth_401 on every route", async () => {
    for (const call of [() => GET(req("GET", null), ctx()), () => confirm(req("POST", null), ctx()), () => recheck(req("POST", null), ctx()), () => cancel(req("POST", null), ctx())]) {
      const res = await call()
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "Unauthorized" })
    }
    expect(h.confirmDraft).not.toHaveBeenCalled()
  })

  it("invalid jwt is 401", async () => {
    h.user = null
    expect((await confirm(req("POST"), ctx())).status).toBe(401)
  })

  it("users read error fails closed with 503", async () => {
    h.roleError = { message: "boom" }
    expect((await confirm(req("POST"), ctx())).status).toBe(503)
    expect(h.confirmDraft).not.toHaveBeenCalled()
  })

  it("jwt_metadata_admin_ignored: user_metadata admin but users.role user -> isAdmin false", async () => {
    h.user = { id: "user-1", user_metadata: { role: "admin" } }
    h.role = "user"
    h.confirmDraft.mockResolvedValue({ status: "failed", outcome: { code: "admin_required" }, display: {} })
    await confirm(req("POST"), ctx())
    expect(h.confirmDraft.mock.calls[0][2]).toMatchObject({ userId: "user-1", isAdmin: false, jwt: "tok" })
  })

  it("admin_draft_by_demoted_user: caller is non-admin so the lib refuses the admin draft", async () => {
    h.role = "user"
    h.confirmDraft.mockResolvedValue({ status: "failed", outcome: { code: "admin_required" }, display: {} })
    const res = await confirm(req("POST"), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).outcome.code).toBe("admin_required")
    expect(h.confirmDraft.mock.calls[0][2].isAdmin).toBe(false)
  })

  it("admin role from users table is passed through", async () => {
    h.role = "admin"
    h.confirmDraft.mockResolvedValue({ status: "succeeded", outcome: {}, display: {} })
    await confirm(req("POST"), ctx())
    expect(h.confirmDraft.mock.calls[0][2].isAdmin).toBe(true)
  })
})

describe("confirm / recheck", () => {
  it("confirm_other_users_draft_404 (lib returns null)", async () => {
    h.confirmDraft.mockResolvedValue(null)
    const res = await confirm(req("POST"), ctx())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
  })

  it("recheck null -> 404, otherwise the CardState", async () => {
    h.recheckDraft.mockResolvedValueOnce(null)
    expect((await recheck(req("POST"), ctx())).status).toBe(404)
    h.recheckDraft.mockResolvedValueOnce({ status: "unknown", outcome: null, display: {} })
    const res = await recheck(req("POST"), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("unknown")
  })

  it("invalid_uuid_404 without touching the lib", async () => {
    for (const call of [() => GET(req("GET"), ctx("nope")), () => confirm(req("POST"), ctx("nope")), () => recheck(req("POST"), ctx("nope")), () => cancel(req("POST"), ctx("nope"))]) {
      expect((await call()).status).toBe(404)
    }
    expect(h.confirmDraft).not.toHaveBeenCalled()
    expect(h.getOwnDraft).not.toHaveBeenCalled()
  })

  it("rate_limited_429 for confirm and recheck, keyed on userId, 10 per 60s", async () => {
    h.allowed = false
    expect((await confirm(req("POST"), ctx())).status).toBe(429)
    expect((await recheck(req("POST"), ctx())).status).toBe(429)
    expect(h.confirmDraft).not.toHaveBeenCalled()
    expect(h.recheckDraft).not.toHaveBeenCalled()
    const call = h.applyRateLimit.mock.calls[0]
    expect(call.slice(2)).toEqual([10, 60_000, "user-1"])
  })
})

describe("get", () => {
  it("get_returns_stored_state", async () => {
    h.getOwnDraft.mockResolvedValue(draft({ status: "succeeded", outcome: { order_code: "A1" } }))
    const res = await GET(req("GET"), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "succeeded", outcome: { order_code: "A1" }, display: { title: "x" } })
    expect(h.recoverStaleExecuting).toHaveBeenCalled()
    expect(h.expireIfDue).toHaveBeenCalled()
  })

  it("get on someone else's draft is 404", async () => {
    h.getOwnDraft.mockResolvedValue(null)
    expect((await GET(req("GET"), ctx())).status).toBe(404)
  })
})

describe("cancel", () => {
  it("cancel_pending_only: cancels a pending draft", async () => {
    h.cancelDraft.mockResolvedValue(draft({ status: "cancelled" }))
    const res = await cancel(req("POST"), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("cancelled")
    expect(h.cancelDraft.mock.calls[0].slice(1)).toEqual([ID, "user-1"])
  })

  it("cancel_pending_only: a non-pending owned draft returns its current state", async () => {
    h.cancelDraft.mockResolvedValue(null)
    h.getOwnDraft.mockResolvedValue(draft({ status: "executing" }))
    const res = await cancel(req("POST"), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("executing")
  })

  it("cancel of someone else's draft is 404", async () => {
    h.cancelDraft.mockResolvedValue(null)
    h.getOwnDraft.mockResolvedValue(null)
    expect((await cancel(req("POST"), ctx())).status).toBe(404)
  })
})
