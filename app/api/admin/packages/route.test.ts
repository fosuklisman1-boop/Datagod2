import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const PKG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

type Call = { table: string; op: string; payload?: unknown; opts?: unknown; filters: unknown[][] }
const h = vi.hoisted(() => ({
  verify: vi.fn(),
  calls: [] as Call[],
  results: {} as Record<string, { data?: unknown; error?: unknown }>,
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] }
      h.calls.push(call)
      const q: Record<string, unknown> = {}
      for (const m of ["select", "eq", "in", "order", "limit"]) {
        q[m] = (...a: unknown[]) => {
          call.filters.push([m, ...a])
          return q
        }
      }
      q.insert = (p: unknown) => { call.op = "insert"; call.payload = p; return q }
      q.update = (p: unknown) => { call.op = "update"; call.payload = p; return q }
      q.upsert = (p: unknown, o: unknown) => { call.op = "upsert"; call.payload = p; call.opts = o; return q }
      q.delete = () => { call.op = "delete"; return q }
      q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const r = h.results[`${table}:${call.op}`] ?? { data: table === "packages" ? [{ id: PKG }] : [], error: null }
        return Promise.resolve({ error: null, data: null, ...r }).then(ok, bad)
      }
      return q
    },
  }),
}))

import { GET, POST } from "./route"

const post = async (body: unknown) =>
  (await POST(new NextRequest("http://localhost/api/admin/packages", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  })))!
const costCalls = () => h.calls.filter((c) => c.table === "package_costs")

beforeEach(() => {
  h.calls.length = 0
  h.results = {}
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
})

describe("POST /api/admin/packages cost_price", () => {
  const base = { network: "MTN", size: "1", price: 5 }

  it("rejects a negative cost with 400 and writes nothing", async () => {
    const res = await post({ packageData: { ...base, cost_price: -1 }, isUpdate: false })
    expect(res.status).toBe(400)
    expect(h.calls).toEqual([])
  })

  it("rejects non-finite and non-numeric costs with 400", async () => {
    for (const bad of ["abc", "5", {}, [], true]) {
      const res = await post({ packageData: { ...base, cost_price: bad }, isUpdate: false })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    // 1e999 parses to Infinity in JSON.parse
    const raw = new NextRequest("http://localhost/api/admin/packages", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: '{"packageData":{"network":"MTN","size":"1","price":5,"cost_price":1e999},"isUpdate":false}',
    })
    expect((await POST(raw))!.status).toBe(400)
    expect(h.calls).toEqual([])
  })

  it("rounds 4.555 to 4.56 and upserts into package_costs with updated_by", async () => {
    const res = await post({ packageData: { ...base, cost_price: 4.555 }, isUpdate: false })
    expect(res.status).toBe(200)
    const c = costCalls()
    expect(c).toHaveLength(1)
    expect(c[0].op).toBe("upsert")
    expect(c[0].payload).toMatchObject({ package_id: PKG, cost_price: 4.56, updated_by: ADMIN })
    expect(c[0].opts).toEqual({ onConflict: "package_id" })
  })

  it("never puts cost_price into the packages write", async () => {
    await post({ packageData: { ...base, cost_price: 3 }, isUpdate: false })
    const pkgWrite = h.calls.find((c) => c.table === "packages" && c.op === "insert")
    expect(JSON.stringify(pkgWrite?.payload)).not.toContain("cost_price")
  })

  it("an empty string deletes the cost row", async () => {
    const res = await post({ packageData: { ...base, cost_price: "" }, packageId: PKG, isUpdate: true })
    expect(res.status).toBe(200)
    const c = costCalls()
    expect(c).toHaveLength(1)
    expect(c[0].op).toBe("delete")
    expect(c[0].filters).toContainEqual(["eq", "package_id", PKG])
  })

  it("null deletes the cost row", async () => {
    await post({ packageData: { ...base, cost_price: null }, packageId: PKG, isUpdate: true })
    expect(costCalls().map((c) => c.op)).toEqual(["delete"])
  })

  it("zero is a valid cost", async () => {
    await post({ packageData: { ...base, cost_price: 0 }, packageId: PKG, isUpdate: true })
    expect(costCalls()[0].payload).toMatchObject({ cost_price: 0 })
  })

  it("not provided leaves the cost untouched", async () => {
    const res = await post({ packageData: base, packageId: PKG, isUpdate: true })
    expect(res.status).toBe(200)
    expect(costCalls()).toEqual([])
  })

  it("a cost-only update (no other fields) is accepted", async () => {
    const res = await post({ packageData: { cost_price: 2 }, packageId: PKG, isUpdate: true })
    expect(res.status).toBe(200)
    expect(costCalls()[0].op).toBe("upsert")
  })

  it("does not write the cost when the package write fails", async () => {
    h.results["packages:update"] = { error: { message: "nope" } }
    const res = await post({ packageData: { ...base, cost_price: 3 }, packageId: PKG, isUpdate: true })
    expect(res.status).toBe(400)
    expect(costCalls()).toEqual([])
  })

  it("500 and no success when the cost write fails", async () => {
    h.results["package_costs:upsert"] = { error: { message: "db detail" } }
    const res = await post({ packageData: { ...base, cost_price: 3 }, isUpdate: false })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("db detail")
  })

  it("401 for a non-admin", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await post({ packageData: { ...base, cost_price: 3 }, isUpdate: false })).status).toBe(401)
    expect(h.calls).toEqual([])
  })
})

describe("GET /api/admin/packages (admin-only costs)", () => {
  const get = async () => (await GET(new NextRequest("http://localhost/api/admin/packages", { headers: { authorization: "Bearer t" } })))!

  it("401 for a non-admin, no reads", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    expect(h.calls).toEqual([])
  })

  it("returns cost_price per package id from package_costs", async () => {
    h.results["package_costs:select"] = { data: [{ package_id: PKG, cost_price: "4.56" }] }
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ costs: { [PKG]: 4.56 } })
    expect(h.calls.every((c) => c.table === "package_costs")).toBe(true)
  })

  it("fails closed on a read error, a full page, or a CRON bypass", async () => {
    h.results["package_costs:select"] = { error: { message: "x" } }
    expect((await get()).status).toBe(500)
    h.results["package_costs:select"] = { data: Array.from({ length: 1000 }, (_, i) => ({ package_id: `p${i}`, cost_price: 1 })) }
    expect((await get()).status).toBe(500)
    h.verify.mockResolvedValue({ isAdmin: true })
    h.results["package_costs:select"] = { data: [] }
    expect((await get()).status).toBe(403)
  })
})
