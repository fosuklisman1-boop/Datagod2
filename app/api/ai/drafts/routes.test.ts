import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  user: { id: "user-1", user_metadata: {} as Record<string, unknown> } as { id: string; user_metadata: Record<string, unknown> } | null,
  role: "user" as string | null,
  roleError: null as unknown,
  suspended: false,
  roleThrow: false,
  getUserThrow: false,
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
        if (h.getUserThrow) throw new Error("network")
        return h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad" } }
      },
    },
    from: (table: string) => {
      if (table !== "users") throw new Error("unexpected table " + table)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (h.roleThrow) throw new Error("network")
              return { data: h.role ? { role: h.role, is_suspended: h.suspended } : null, error: h.roleError }
            },
          }),
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
  h.suspended = false
  h.roleThrow = false
  h.getUserThrow = false
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

  it("users_read_throw_returns_503", async () => {
    h.roleThrow = true
    expect((await confirm(req("POST"), ctx())).status).toBe(503)
    expect(h.confirmDraft).not.toHaveBeenCalled()
  })

  it("get_user_throw_returns_401", async () => {
    h.getUserThrow = true
    expect((await confirm(req("POST"), ctx())).status).toBe(401)
    expect(h.confirmDraft).not.toHaveBeenCalled()
  })

  it("missing_users_row_is_suspended_403 on confirm and recheck (Phase 2 review M3)", async () => {
    h.role = "" // fake returns no row at all
    for (const call of [() => confirm(req("POST"), ctx()), () => recheck(req("POST"), ctx())]) {
      const res = await call()
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "Account suspended" })
    }
    expect(h.confirmDraft).not.toHaveBeenCalled()
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

describe("confirm body (secure box)", () => {
  const withBody = (body: string | undefined, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost/api/ai/drafts/${ID}/confirm`, {
      method: "POST",
      headers: { authorization: "Bearer tok", ...headers },
      ...(body === undefined ? {} : { body }),
    })

  it("a missing or empty body is {} (existing confirms keep working)", async () => {
    h.confirmDraft.mockResolvedValue({ status: "succeeded", outcome: {}, display: {} })
    expect((await confirm(req("POST"), ctx())).status).toBe(200)
    expect((await confirm(withBody(""), ctx())).status).toBe(200)
    expect((await confirm(withBody("{}"), ctx())).status).toBe(200)
    for (const call of h.confirmDraft.mock.calls) expect(call[3]).toBeUndefined()
  })

  it("passes the secrets object through to confirmDraft", async () => {
    h.confirmDraft.mockResolvedValue({ status: "succeeded", outcome: {}, display: {} })
    await confirm(withBody(JSON.stringify({ secrets: { apiKey: "abcdefgh1" } })), ctx())
    expect(h.confirmDraft.mock.calls[0][3]).toEqual({ apiKey: "abcdefgh1" })
  })

  it("a refusal from the lib is a 400 with its code, and never echoes the body", async () => {
    h.confirmDraft.mockResolvedValue({ refused: true, code: "missing_secret", message: "Enter API key (8-100 characters) in the box on the card." })
    const res = await confirm(withBody(JSON.stringify({ secrets: { apiKey: "SECRET-VALUE-1" } })), ctx())
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(JSON.parse(text).code).toBe("missing_secret")
    expect(text).not.toContain("SECRET-VALUE-1")
  })

  it("bad_secret is also a 400", async () => {
    h.confirmDraft.mockResolvedValue({ refused: true, code: "bad_secret", message: "Unexpected secret field." })
    const res = await confirm(withBody(JSON.stringify({ secrets: { nope: "x" } })), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("bad_secret")
  })

  it("a body over 4 KB is 413 and confirmDraft is not called", async () => {
    const big = JSON.stringify({ secrets: { apiKey: "x".repeat(5000) } })
    expect((await confirm(withBody(big), ctx())).status).toBe(413)
    // A lying content-length does not help: the real size is checked too.
    expect((await confirm(withBody(big, { "content-length": "10" }), ctx())).status).toBe(413)
    expect(h.confirmDraft).not.toHaveBeenCalled()
  })

  it("malformed JSON is a 400 and confirmDraft is not called", async () => {
    const res = await confirm(withBody("{not json"), ctx())
    expect(res.status).toBe(400)
    expect(h.confirmDraft).not.toHaveBeenCalled()
  })

  it("the secret never reaches the logs on a failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.confirmDraft.mockRejectedValue(new Error("boom"))
    const res = await confirm(withBody(JSON.stringify({ secrets: { apiKey: "SECRET-VALUE-2" } })), ctx())
    expect(res.status).toBe(500)
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-VALUE-2")
    spy.mockRestore()
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

describe("suspension", () => {
  it("suspended_confirm_403", async () => {
    h.suspended = true
    const res = await confirm(req("POST"), ctx())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Account suspended" })
    expect(h.confirmDraft).not.toHaveBeenCalled()
  })

  it("suspended_recheck_403", async () => {
    h.suspended = true
    const res = await recheck(req("POST"), ctx())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Account suspended" })
    expect(h.recheckDraft).not.toHaveBeenCalled()
  })

  it("suspended_get_allowed (and cancel)", async () => {
    h.suspended = true
    h.getOwnDraft.mockResolvedValue(draft())
    expect((await GET(req("GET"), ctx())).status).toBe(200)
    h.cancelDraft.mockResolvedValue(draft({ status: "cancelled" }))
    expect((await cancel(req("POST"), ctx())).status).toBe(200)
  })
})
