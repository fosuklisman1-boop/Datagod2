import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ active: false }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async (t: string) =>
        t === "good" ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { message: "bad" } },
    },
  }),
}))
vi.mock("@/lib/admin-presence", () => ({ isSupportActive: vi.fn(async () => h.active) }))

import { GET } from "./route"

const call = (token: string | null) =>
  GET(new NextRequest("http://localhost/api/support/presence", { headers: token ? { Authorization: `Bearer ${token}` } : {} }))

beforeEach(() => { h.active = false })

describe("GET /api/support/presence", () => {
  it("401 when signed out", async () => {
    expect((await call(null)).status).toBe(401)
  })

  it("reports whether support is active", async () => {
    h.active = true
    expect(await (await call("good")).json()).toEqual({ success: true, data: { active: true } })
    h.active = false
    expect((await (await call("good")).json()).data.active).toBe(false)
  })
})
