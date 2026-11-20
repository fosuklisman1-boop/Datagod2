import { GET } from "./route"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetRightsCache } from "@/lib/roles/permissions-repo"

const h = vi.hoisted(() => {
  const state = { session: true, role: "dealer" as string | null, fail: null as string | null }
  const ROLE_ROWS = [
    { id: "r-user", slug: "user", rank: 10, is_system: true, archived_at: null, name: "User", badge_color: null, icon: null, theme: { skin: "default" } },
    { id: "r-dealer", slug: "dealer", rank: 20, is_system: true, archived_at: null, name: "Dealer", badge_color: "#f59e0b", icon: "crown", theme: { skin: "dealer" } },
  ]
  const fake = {
    auth: {
      getUser: async () => ({ data: { user: state.session ? { id: "user-1" } : null } }),
    },
    from(table: string) {
      let slugFilter: string | null = null
      const result = () => {
        if (state.fail === table) return { data: null, error: { message: "boom" } }
        if (table === "users") return { data: { role: state.role }, error: null }
        if (table === "roles") {
          if (slugFilter) return { data: ROLE_ROWS.find((r) => r.slug === slugFilter) ?? null, error: null }
          return { data: ROLE_ROWS, error: null }
        }
        return {
          data: [
            { role_id: "r-dealer", capability: "buy.data" },
            { role_id: "r-dealer", capability: "buy.airtime" },
          ],
          error: null,
        }
      }
      const b: any = {
        select: () => b,
        eq: (col: string, v: string) => ((if_slug(col, v)), b),
        limit: () => b,
        order: () => b,
        range: () => b,
        maybeSingle: () => Promise.resolve(result()),
        then: (res: any, rej: any) => Promise.resolve(result()).then(res, rej),
      }
      function if_slug(col: string, v: string) {
        if (col === "slug") slugFilter = v
      }
      return b
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

function req(token: string | null = "t") {
  return new NextRequest("http://localhost/api/user/role", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

beforeEach(() => {
  h.state.session = true
  h.state.role = "dealer"
  h.state.fail = null
  __resetRightsCache()
})

describe("GET /api/user/role", () => {
  it("401 without a token", async () => {
    const res = await GET(req(null))
    expect(res.status).toBe(401)
  })

  it("401 when the session does not resolve", async () => {
    h.state.session = false
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it("200 shape for a dealer", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      slug: "dealer",
      name: "Dealer",
      badge_color: "#f59e0b",
      icon: "crown",
      theme: { skin: "dealer" },
      rights: ["buy.data", "buy.airtime"],
    })
  })

  it("admin gets rights 'all' and sub_agent 'sub_agent'", async () => {
    h.state.role = "admin"
    expect((await (await GET(req())).json()).rights).toBe("all")
    __resetRightsCache()
    h.state.role = "sub_agent"
    expect((await (await GET(req())).json()).rights).toBe("sub_agent")
  })

  it("503 on a read error", async () => {
    h.state.fail = "role_permissions"
    const res = await GET(req())
    expect(res.status).toBe(503)
  })
})
