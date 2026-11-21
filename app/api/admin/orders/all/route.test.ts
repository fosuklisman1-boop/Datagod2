import { GET } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () => ({ isAdmin: true }),
}))

const calls: { range?: [number, number]; or?: string } = {}
vi.mock("@supabase/supabase-js", () => {
  const q: Record<string, unknown> = {}
  const chain = () => q
  for (const m of ["select", "gte", "lte", "eq", "in", "order", "ilike"]) q[m] = chain
  q.or = (s: string) => { calls.or = s; return q }
  q.range = async (a: number, b: number) => { calls.range = [a, b]; return { data: [], error: null, count: 0 } }
  return { createClient: () => ({ from: () => q }) }
})

const get = (qs: string) => new NextRequest(`http://localhost/api/admin/orders/all${qs}`)

beforeEach(() => { delete calls.range; delete calls.or })

describe("GET /api/admin/orders/all hardening", () => {
  it("clamps limit to 200", async () => {
    await GET(get("?limit=100000"))
    expect(calls.range).toEqual([0, 199])
  })
  it("clamps limit to at least 1 and handles junk", async () => {
    await GET(get("?limit=0"))
    expect(calls.range).toEqual([0, 0])
    await GET(get("?limit=abc&offset=zzz"))
    expect(calls.range).toEqual([0, 49])
  })
  it("strips filter-syntax characters from the search", async () => {
    await GET(get("?search=" + encodeURIComponent("x,y)")))
    expect(calls.or).toBeDefined()
    expect(calls.or).not.toContain(",y")
    expect(calls.or).not.toContain("y)")
  })
  it("escapes LIKE wildcards", async () => {
    await GET(get("?search=" + encodeURIComponent("a%b_c\\d")))
    expect(calls.or).toContain("a\\%b\\_c\\\\d")
  })
})
