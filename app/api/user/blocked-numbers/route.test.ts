import { describe, it, expect, vi, beforeEach } from "vitest"
import * as XLSX from "xlsx"

type Call = { table: string; ops: Array<[string, unknown[]]> }
let calls: Call[] = []
let tables: Record<string, unknown[]> = {}
let authUser: { id: string } | null = { id: "user-1" }

function builder(table: string) {
  const call: Call = { table, ops: [] }
  calls.push(call)
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in", "gte", "lte", "order", "limit"]) {
    b[m] = (...args: unknown[]) => {
      call.ops.push([m, args])
      return b
    }
  }
  b.then = (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [], error: null })
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: authUser }, error: authUser ? null : new Error("bad") }) },
    from: (t: string) => builder(t),
  },
}))
vi.mock("@/lib/blocked-numbers/settings", () => ({
  getBlockedNumbersSettings: async () => ({ enabled: true }),
}))

import { GET } from "./route"
import { GET as EXPORT } from "./export/route"

const req = (qs: string, auth = true, path = "api/user/blocked-numbers") =>
  new Request(`http://x/${path}?${qs}`, { headers: auth ? { authorization: "Bearer tok" } : {} }) as never

const attemptCall = () => calls.find((c) => c.table === "mtn_blocked_attempts" && c.ops.some(([m]) => m === "order"))!
const opArgs = (c: Call, name: string) => c.ops.filter(([m]) => m === name).map(([, a]) => a)

beforeEach(() => {
  calls = []
  authUser = { id: "user-1" }
  tables = {
    user_shops: [{ id: "shop-1" }, { id: "shop-2" }],
    mtn_blocked_attempts: [
      { phone: "0241111111", surface: "storefront", product: "MTN 1GB", created_at: "2026-11-10T10:00:00Z" },
    ],
    mtn_blocked_numbers: [{ phone: "0241111111", status: "allowed" }],
  }
})

describe("GET /api/user/blocked-numbers", () => {
  it("401 without a Bearer token", async () => {
    const res = await GET(req("section=shops", false))
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it("401 when the token does not resolve to a user", async () => {
    authUser = null
    const res = await GET(req("section=shops"))
    expect(res.status).toBe(401)
  })

  it("shops section filters by the session user shop ids and ignores client shop_id/user_id", async () => {
    const res = await GET(req("section=shops&shop_id=evil&user_id=evil"))
    expect(res.status).toBe(200)
    const shopsCall = calls.find((c) => c.table === "user_shops")!
    expect(opArgs(shopsCall, "eq")).toContainEqual(["user_id", "user-1"])
    const a = attemptCall()
    expect(opArgs(a, "in")).toContainEqual(["shop_id", ["shop-1", "shop-2"]])
    expect(JSON.stringify(a.ops)).not.toContain("evil")
    const body = await res.json()
    expect(body).toMatchObject({ total: 1, page: 1, hasShops: true, enabled: true })
    expect(body.rows[0]).toMatchObject({ phone: "0241111111", status: "ready", attempts: 1 })
  })

  it("orders section filters by user_id and dealer surfaces", async () => {
    const res = await GET(req("section=orders&user_id=evil"))
    expect(res.status).toBe(200)
    const a = attemptCall()
    expect(opArgs(a, "eq")).toContainEqual(["user_id", "user-1"])
    const surfaceIn = opArgs(a, "in").find((args) => args[0] === "surface")!
    expect(surfaceIn[1]).toEqual(expect.arrayContaining(["dashboard", "dashboard_bulk", "api_v1", "api_v2"]))
    expect(surfaceIn[1]).not.toContain("storefront")
    expect(JSON.stringify(a.ops)).not.toContain("evil")
  })

  it("pages at 50 per page", async () => {
    tables.mtn_blocked_attempts = Array.from({ length: 120 }, (_, i) => ({
      phone: `024${String(1000000 + i)}`,
      surface: "storefront",
      product: null,
      created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
    }))
    tables.mtn_blocked_numbers = []
    const res = await GET(req("section=shops&page=3"))
    const body = await res.json()
    expect(body.total).toBe(120)
    expect(body.page).toBe(3)
    expect(body.rows).toHaveLength(20)
  })

  it("filters by status after aggregation", async () => {
    const res = await GET(req("section=shops&status=waiting"))
    const body = await res.json()
    expect(body.total).toBe(0)
  })

  it("bounds the attempt read to 10,000", async () => {
    await GET(req("section=shops"))
    expect(opArgs(attemptCall(), "limit")).toContainEqual([10000])
  })
})

describe("GET /api/user/blocked-numbers/export", () => {
  it("401 without a Bearer token", async () => {
    const res = await EXPORT(req("section=shops", false, "api/user/blocked-numbers/export"))
    expect(res.status).toBe(401)
  })

  it("returns an xlsx with the expected columns, capped at 10,000 rows", async () => {
    tables.mtn_blocked_attempts = Array.from({ length: 10050 }, (_, i) => ({
      phone: `0${String(240000000 + i)}`,
      surface: "storefront",
      product: "MTN 1GB",
      created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, i % 60)).toISOString(),
    }))
    tables.mtn_blocked_numbers = []
    const res = await EXPORT(req("section=shops", true, "api/user/blocked-numbers/export"))
    expect(res.status).toBe(200)
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array" })
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]])
    expect(rows).toHaveLength(10000)
    expect(Object.keys(rows[0])).toEqual(["Phone", "First tried", "Last tried", "Attempts", "Product", "Status"])
  })
})
