import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const verifyAdminAccess = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => verifyAdminAccess(...a) }))

type Page = { data: unknown[] | null; error: unknown }
let pages: Page[] = []
const ranges: Array<[number, number]> = []
const filters: Array<[string, unknown[]]> = []

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      filters.push(["from", [table]])
      const b: any = {
        select: (...a: unknown[]) => (filters.push(["select", a]), b),
        gte: (...a: unknown[]) => (filters.push(["gte", a]), b),
        order: (...a: unknown[]) => (filters.push(["order", a]), b),
        range: (from: number, to: number) => {
          ranges.push([from, to])
          return Promise.resolve(pages.shift() ?? { data: [], error: null })
        },
      }
      return b
    },
  },
}))

import { GET } from "./route"

const req = () => new NextRequest("http://localhost/api/admin/signup-sources", { headers: { authorization: "Bearer t" } })
const row = (landing: string | null) => ({ signup_source: landing ? { landing, ref: null, at: "2026-10-20T00:00:00.000Z" } : null })

beforeEach(() => {
  pages = []
  ranges.length = 0
  filters.length = 0
  verifyAdminAccess.mockResolvedValue({ isAdmin: true, userId: "admin" })
})

describe("GET /api/admin/signup-sources", () => {
  it("refuses non-admins", async () => {
    const { NextResponse } = await import("next/server")
    verifyAdminAccess.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(filters).toHaveLength(0)
  })

  it("counts sign-ups of the last 30 days per landing page", async () => {
    pages = [{ data: [row("/mtn-data"), row("/mtn-data"), row(null), { signup_source: { landing: "/<x>" } }], error: null }]
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(4)
    expect(body.truncated).toBe(false)
    expect(body.rows).toEqual([
      { landing: "/mtn-data", count: 2 },
      { landing: "unknown", count: 2 },
    ])
    const gte = filters.find(f => f[0] === "gte")!
    expect(gte[1][0]).toBe("created_at")
    const since = Date.parse(String(gte[1][1]))
    expect(Date.now() - since).toBeGreaterThan(29.9 * 86400000)
    expect(Date.now() - since).toBeLessThan(30.1 * 86400000)
  })

  it("pages in chunks of 1000 and stops at 5000 rows", async () => {
    const full = { data: Array.from({ length: 1000 }, () => row("/")), error: null }
    pages = [full, full, full, full, full, full]
    const body = await (await GET(req())).json()
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999], [3000, 3999], [4000, 4999]])
    expect(body.total).toBe(5000)
    expect(body.truncated).toBe(true)
  })

  it("returns 500 without DB details when the read fails (e.g. column missing)", async () => {
    pages = [{ data: null, error: { code: "42703", message: "column users.signup_source does not exist" } }]
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("column")
  })
})
