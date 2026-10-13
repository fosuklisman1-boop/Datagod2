import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

// ---- fake Supabase: auth by token, a user_nav_clicks table, and nav_click() ----
type Row = { user_id: string; href: string; clicks: number }
const db: { rows: Row[]; selectError: unknown; rpcError: unknown; lastSelectUser: string | null } = {
  rows: [], selectError: null, rpcError: null, lastSelectUser: null,
}
const TOKENS: Record<string, string> = { "tok-a": "user-a", "tok-b": "user-b" }

function fakeClient() {
  return {
    auth: {
      getUser: async (token: string) =>
        TOKENS[token]
          ? { data: { user: { id: TOKENS[token] } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => {
      if (table !== "user_nav_clicks") throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: async (col: string, val: string) => {
            if (col !== "user_id") throw new Error("must filter by user_id")
            db.lastSelectUser = val
            if (db.selectError) return { data: null, error: db.selectError }
            return { data: db.rows.filter(r => r.user_id === val).map(({ href, clicks }) => ({ href, clicks })), error: null }
          },
        }),
      }
    },
    rpc: async (fn: string, args: { p_user_id: string; p_href: string }) => {
      if (fn !== "nav_click") throw new Error(`unexpected rpc ${fn}`)
      if (db.rpcError) return { data: null, error: db.rpcError }
      let row = db.rows.find(r => r.user_id === args.p_user_id && r.href === args.p_href)
      if (!row) { row = { user_id: args.p_user_id, href: args.p_href, clicks: 0 }; db.rows.push(row) }
      row.clicks = Math.min(2, row.clicks + 1)
      return { data: row.clicks, error: null }
    },
  }
}

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => fakeClient()) }))
vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async () => ({ allowed: true, remaining: 59, resetAt: Date.now() + 60000 })),
}))

import { GET, POST } from "./route"

function req(method: "GET" | "POST", token?: string, body?: unknown) {
  return new NextRequest("http://localhost/api/user/nav-new", {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  db.rows = []
  db.selectError = null
  db.rpcError = null
  db.lastSelectUser = null
  vi.clearAllMocks()
})

describe("GET /api/user/nav-new", () => {
  it("401 without a bearer token", async () => {
    expect((await GET(req("GET"))).status).toBe(401)
  })
  it("401 with an invalid token", async () => {
    expect((await GET(req("GET", "nope"))).status).toBe(401)
  })
  it("returns only the caller's rows, only registry hrefs", async () => {
    db.rows = [
      { user_id: "user-a", href: "/dashboard/sms", clicks: 1 },
      { user_id: "user-a", href: "/retired-item", clicks: 2 },
      { user_id: "user-b", href: "/admin/sms", clicks: 2 },
    ]
    const res = await GET(req("GET", "tok-a"))
    expect(res.status).toBe(200)
    expect(db.lastSelectUser).toBe("user-a")
    expect(await res.json()).toEqual({ success: true, data: { clicks: { "/dashboard/sms": 1 } } })
  })
  it("500 (never a fake empty success) when the table read fails, e.g. migration not applied", async () => {
    db.selectError = { message: "relation does not exist", code: "42P01" }
    const res = await GET(req("GET", "tok-a"))
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})

describe("POST /api/user/nav-new", () => {
  it("401 without auth", async () => {
    expect((await POST(req("POST", undefined, { href: "/dashboard/sms" }))).status).toBe(401)
  })
  it("400 for a href outside the registry", async () => {
    const res = await POST(req("POST", "tok-a", { href: "/dashboard/wallet" }))
    expect(res.status).toBe(400)
    expect(db.rows).toEqual([])
  })
  it("400 for a missing href or bad JSON", async () => {
    expect((await POST(req("POST", "tok-a", {}))).status).toBe(400)
    expect((await POST(req("POST", "tok-a", "{not json"))).status).toBe(400)
  })
  it("increments for the caller and caps at 2", async () => {
    const bodies = []
    for (let i = 0; i < 3; i++) {
      const res = await POST(req("POST", "tok-a", { href: "/dashboard/sms" }))
      expect(res.status).toBe(200)
      bodies.push(await res.json())
    }
    expect(bodies.map(b => b.data.clicks)).toEqual([1, 2, 2])
    expect(bodies[0]).toEqual({ success: true, data: { href: "/dashboard/sms", clicks: 1 } })
    expect(db.rows).toEqual([{ user_id: "user-a", href: "/dashboard/sms", clicks: 2 }])
  })
  it("writes to the caller's row only (ignores any user id in the body)", async () => {
    await POST(req("POST", "tok-b", { href: "/admin/sms", user_id: "user-a" }))
    expect(db.rows).toEqual([{ user_id: "user-b", href: "/admin/sms", clicks: 1 }])
  })
  it("429 when rate limited, per user", async () => {
    const { applyRateLimit } = await import("@/lib/rate-limiter")
    ;(applyRateLimit as any).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60000 })
    const res = await POST(req("POST", "tok-a", { href: "/dashboard/sms" }))
    expect(res.status).toBe(429)
    expect((applyRateLimit as any).mock.calls[0][4]).toBe("user-a")
    expect(db.rows).toEqual([])
  })
  it("500 when nav_click fails", async () => {
    db.rpcError = { message: "function nav_click does not exist" }
    expect((await POST(req("POST", "tok-a", { href: "/dashboard/sms" }))).status).toBe(500)
  })
})
