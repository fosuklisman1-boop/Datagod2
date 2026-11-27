import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

type Row = { context: string; user_id: string | null }
const h = vi.hoisted(() => ({
  admin: true,
  rows: [] as Array<{ context: string; user_id: string | null }>,
  usage: null as null | { creditsLeft: number | null; renewsAt: string | null },
  queries: [] as unknown[][][],
  countError: false,
}))

// A head-count query: the mock applies the eq / is filters to h.rows and returns only a count (no rows), like PostgREST.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const ops: unknown[][] = []
      const chain: Record<string, unknown> = {}
      for (const m of ["select", "gte", "or", "eq", "is", "limit"]) {
        chain[m] = (...a: unknown[]) => { ops.push([m, ...a]); return chain }
      }
      chain.then = (res: (v: unknown) => unknown) => {
        h.queries.push(ops)
        const sel = ops.find((o) => o[0] === "select")
        // A row-returning select would be capped by PostgREST max-rows: only head counts are allowed.
        if (!(sel && (sel[2] as { head?: boolean } | undefined)?.head)) return Promise.resolve({ data: h.rows, error: null }).then(res)
        if (h.countError) return Promise.resolve({ count: null, error: { message: "x" } }).then(res)
        let rows: Row[] = h.rows
        for (const o of ops) {
          if (o[0] === "eq" && o[1] === "context") rows = rows.filter((r) => r.context === o[2])
          if (o[0] === "is" && o[1] === "user_id" && o[2] === null) rows = rows.filter((r) => r.user_id === null)
        }
        return Promise.resolve({ count: rows.length, error: null }).then(res)
      }
      return chain
    },
  }),
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () => h.admin
    ? { isAdmin: true, userId: "a", errorResponse: null }
    : { isAdmin: false, userId: null, errorResponse: new Response("no", { status: 403 }) },
}))
vi.mock("@/lib/ai-voice/nuance", () => ({ getNuanceUsage: async () => h.usage }))

import { GET } from "./route"
const get = () => GET(new NextRequest("http://localhost/api/admin/ai-voice/usage"))

beforeEach(() => {
  h.admin = true
  h.rows = []
  h.usage = null
  h.queries = []
  h.countError = false
})

describe("ai voice usage", () => {
  it("refuses non-admins", async () => {
    h.admin = false
    expect((await get()).status).toBe(403)
  })

  it("returns today's counts and Nuance usage", async () => {
    h.rows = [
      { context: "home", user_id: null },
      { context: "storefront", user_id: null },
      { context: "home", user_id: "u1" },
      { context: "dashboard", user_id: "u2" },
      { context: "admin", user_id: "a" },
    ]
    h.usage = { creditsLeft: 120, renewsAt: "2026-12-01T00:00:00Z" }
    process.env.NUANCE_API_KEY = "nk_1"
    process.env.NUANCE_API_KEY_2 = "nk_2"
    process.env.NUANCE_API_KEY_3 = "nk_3"
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      callsToday: { total: 5, visitors: 2, dashboard: 1, admin: 1 },
      creditsLeft: 120,
      renewsAt: "2026-12-01T00:00:00Z",
      accounts: 3,
    })
  })

  it("M2: every figure is a head count (no row fetch, no .limit that PostgREST max-rows would silently cap)", async () => {
    await get()
    expect(h.queries).toHaveLength(4)
    for (const ops of h.queries) {
      const sel = ops.find((o) => o[0] === "select")!
      expect(sel[1]).toBe("id")
      expect(sel[2]).toEqual({ count: "exact", head: true })
      expect(ops.some((o) => o[0] === "limit")).toBe(false)
      // cap_exceeded rows never count
      expect(JSON.stringify(ops)).toContain("cap_exceeded")
    }
  })

  it("M2: counts well past the PostgREST row cap are reported in full", async () => {
    h.rows = Array.from({ length: 2500 }, (_, i) => ({ context: "home", user_id: i % 2 ? null : "u" }))
    const body = await (await get()).json()
    expect(body.callsToday.total).toBe(2500)
    expect(body.callsToday.visitors).toBe(1250)
  })

  it("a failed count -> 500", async () => {
    h.countError = true
    expect((await get()).status).toBe(500)
  })

  it("still answers 200 with null credits when Nuance is down", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ creditsLeft: null, renewsAt: null })
  })
})
