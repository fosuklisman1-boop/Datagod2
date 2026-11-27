import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  admin: true,
  rows: [] as Array<{ context: string; user_id: string | null }>,
  usage: null as null | { creditsLeft: number | null; renewsAt: string | null },
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.gte = () => chain
      chain.or = () => chain
      chain.limit = async () => ({ data: h.rows, error: null })
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
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      callsToday: { total: 5, visitors: 2, dashboard: 1, admin: 1 },
      creditsLeft: 120,
      renewsAt: "2026-12-01T00:00:00Z",
    })
  })

  it("still answers 200 with null credits when Nuance is down", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ creditsLeft: null, renewsAt: null })
  })
})
