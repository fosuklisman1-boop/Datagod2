import { GET } from "./route"
import { NextRequest, NextResponse } from "next/server"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: (...a: unknown[]) => verifyMock(...a),
}))

const rpcMock = vi.fn()
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: (...a: unknown[]) => rpcMock(...a) }),
}))

const get = (q = "") => new NextRequest(`http://localhost/api/admin/orders/queue${q}`)

const countsRows = [
  { view: "needs_action", n: 7 },
  { view: "held", n: 1 },
  { view: "stuck", n: 2 },
  { view: "failed", n: 3 },
  { view: "all", n: 100 },
]
const dbRow = {
  id: "o1", created_at: "2026-11-21T00:00:00Z", phone_number: "0241234567", price: 5, network: "MTN",
  status: "failed", payment_status: "paid", payment_reference: "ref", volume_gb: "1", type: "bulk",
  customer_email: "a@b.c", store_name: null, shop_owner_email: null, last_provider: "hubnet",
  last_attempt_status: "failed", last_error: "x", attempt_count: 2, has_reversal: false, is_held: false,
  failure_reason: "rejected", total_count: 3,
}

let logs: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  logs = []
  for (const k of ["log", "error", "warn", "info"] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")) })
  }
  verifyMock.mockResolvedValue({ isAdmin: true })
  rpcMock.mockImplementation(async (name: string) =>
    name === "admin_order_queue" ? { data: [dbRow], error: null } : { data: countsRows, error: null })
})
afterEach(() => vi.restoreAllMocks())

describe("GET /api/admin/orders/queue", () => {
  it("returns the auth error for non-admins", async () => {
    verifyMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "nope" }, { status: 403 }) })
    const res = await GET(get())
    expect(res.status).toBe(403)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it("400s on invalid params", async () => {
    expect((await GET(get("?view=bogus"))).status).toBe(400)
  })

  it("calls both RPCs with mapped args and shapes the response", async () => {
    const res = await GET(get("?view=failed&networks=MTN&types=bulk&search=abc&lastProvider=hubnet&failureReason=rejected&limit=10&offset=0"))
    expect(res.status).toBe(200)
    const q = rpcMock.mock.calls.find((c) => c[0] === "admin_order_queue")![1]
    expect(q).toMatchObject({
      p_view: "failed", p_networks: ["MTN"], p_types: ["bulk"], p_search: "abc",
      p_last_provider: "hubnet", p_failure_reason: "rejected", p_limit: 10, p_offset: 0,
    })
    const c = rpcMock.mock.calls.find((c) => c[0] === "admin_order_queue_counts")![1]
    expect(c).toMatchObject({ p_networks: ["MTN"], p_types: ["bulk"], p_search: "abc", p_last_provider: "hubnet", p_failure_reason: "rejected" })
    expect(c).not.toHaveProperty("p_view")
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.counts).toEqual({ needs_action: 7, held: 1, stuck: 2, failed: 3, all: 100 })
    expect(body.total).toBe(3)
    expect(body.hasMore).toBe(true) // 0 + 1 row < 3
    expect(body.data[0]).toMatchObject({ id: "o1", phoneNumber: "0241234567", lastProvider: "hubnet", failureReason: "rejected", attemptCount: 2 })
    expect(body.data[0]).not.toHaveProperty("totalCount")
  })

  it("takes total from counts so a page past the end still reports it", async () => {
    rpcMock.mockImplementation(async (name: string) =>
      name === "admin_order_queue" ? { data: [], error: null } : { data: countsRows, error: null })
    const body = await (await GET(get("?view=failed&offset=100"))).json()
    expect(body.total).toBe(3)
    expect(body.hasMore).toBe(false)
  })

  it("hasMore is true when more rows remain", async () => {
    const body = await (await GET(get("?view=all&limit=1"))).json()
    expect(body.total).toBe(100)
    expect(body.hasMore).toBe(true)
  })

  it("RPC error gives a generic 500 and no digit runs in logs", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom 0241234567 secret" } })
    const res = await GET(get("?search=0241234567"))
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain("0241234567")
    expect(text).not.toContain("boom")
    expect(logs.join("\n")).not.toMatch(/\d{9,}/)
  })

  it("never logs the search text", async () => {
    await GET(get("?search=0241234567"))
    expect(logs.join("\n")).not.toMatch(/\d{9,}/)
  })
})
