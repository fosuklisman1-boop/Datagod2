import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { createFakeDb, USER_ID, type FakeDb, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { GET as RAW_GET } from "./route"

const GET = async (qs = "", id = USER_ID) =>
  (await RAW_GET(new NextRequest(`http://x/api/admin/users/${id}/orders${qs}`), { params: Promise.resolve({ id }) }))!
const RESULT = {
  total: 1002,
  total_capped: true,
  has_more: true,
  counts: { data: 1000, airtime: 2 },
  capped_sources: ["data"],
  count_cap: 1000,
  rows: [{ source: "data", id: "o1", reference: null, description: "MTN 5", recipient: "0244", amount: 25, status: "completed", created_at: "2026-10-01T10:00:00Z" }],
}

beforeEach(() => {
  h.gate = "admin"
  h.fake = createFakeDb({ rpc: () => ({ data: RESULT, error: null }) })
})

describe("GET /api/admin/users/[id]/orders", () => {
  it("returns the gate's response for non-admins and for a rate-limited admin, without querying", async () => {
    for (const [mode, status] of [["forbidden", 403], ["rate_limited", 429]] as const) {
      h.gate = mode
      expect((await GET()).status, mode).toBe(status)
    }
    expect(h.fake.rpcCalls).toHaveLength(0)
  })

  it("400s on a bad uuid", async () => {
    for (const bad of ["nope", "1 or 1=1", `${USER_ID}x`]) expect((await GET("", bad)).status, bad).toBe(400)
    expect(h.fake.rpcCalls).toHaveLength(0)
  })

  it("defaults to page 1 of 20 and passes limit/offset to admin_user_orders", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      rows: RESULT.rows, total: 1002, totalCapped: true, hasMore: true,
      counts: { data: 1000, airtime: 2 }, cappedSources: ["data"], countCap: 1000, page: 1, pageSize: 20,
    })
    expect(h.fake.rpcCalls).toEqual([{
      name: "admin_user_orders",
      args: { p_user_id: USER_ID, p_source: null, p_status: null, p_limit: 20, p_offset: 0 },
    }])
  })

  it("maps page, pageSize, source and status", async () => {
    await GET("?page=3&pageSize=10&source=airtime&status=failed")
    expect(h.fake.rpcCalls[0].args).toEqual({ p_user_id: USER_ID, p_source: "airtime", p_status: "failed", p_limit: 10, p_offset: 20 })
  })

  it("400s on bad paging or filters", async () => {
    for (const qs of ["?page=0", "?page=-1", "?page=1.5", "?page=abc", "?pageSize=0", "?pageSize=51", "?page=10001", "?source=shop", "?status=weird"]) {
      expect((await GET(qs)).status, qs).toBe(400)
    }
    expect(h.fake.rpcCalls).toHaveLength(0)
  })

  it("tolerates a sparse RPC result", async () => {
    h.fake = createFakeDb({ rpc: () => ({ data: { rows: [], total: 0 }, error: null }) })
    expect(await (await GET()).json()).toEqual({
      rows: [], total: 0, totalCapped: false, hasMore: false, counts: {}, cappedSources: [], countCap: 1000, page: 1, pageSize: 20,
    })
  })

  it("500s when the RPC fails", async () => {
    h.fake = createFakeDb({ rpc: () => ({ data: null, error: { message: "boom" } }) })
    expect((await GET()).status).toBe(500)
  })

  it("is read-only and allowed for the CRON bypass", async () => {
    h.gate = "cron"
    expect((await GET()).status).toBe(200)
    expect(h.fake.queries).toHaveLength(0)
  })
})
