import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ctx, ADMIN, role } from "../../test-utils"

const h = vi.hoisted(() => ({ verify: vi.fn(), fake: null as unknown as ReturnType<typeof makeFake> }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
import { NextResponse } from "next/server"
import { POST } from "./route"

const U = "eeeeeeee-0000-4000-8000-000000000005"
const A = "aaaaaaaa-0000-4000-8000-000000000001"
const B = "bbbbbbbb-0000-4000-8000-000000000002"
const C = "cccccccc-0000-4000-8000-000000000003"
const DEALER = "99999999-0000-4000-8000-000000000009"
const ARCH ="dddddddd-0000-4000-8000-000000000004"
const body = (direction: string) => ({ direction, reason: "reorder" })

beforeEach(() => {
  h.fake = makeFake()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.fake.tables.roles = {
    data: [
      role(U, "user", 0, { is_system: true }),
      role(DEALER, "dealer", 10, { is_system: true }),
      role(A, "bronze", 15),
      role(B, "silver", 20),
      role(ARCH, "old", 25, { archived_at: "2026-01-01" }),
      role(C, "gold", 30),
      role("ffffffff-0000-4000-8000-000000000006", "admin", 100, { is_system: true }),
    ],
  }
})

describe("POST /api/admin/roles/[id]/move", () => {
  it("401 / 403 CRON bypass", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await POST(reqOf("POST", body("up")), ctx(B))).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true })
    expect((await POST(reqOf("POST", body("up")), ctx(B))).status).toBe(403)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("swaps with the nearest live neighbour, skipping archived roles", async () => {
    const up = await POST(reqOf("POST", body("up")), ctx(B))
    expect(up.status).toBe(200)
    expect(h.fake.calls.rpc[0]).toEqual({ name: "admin_role_swap_rank", args: { p_actor: ADMIN, p_reason: "reorder", p_a: B, p_b: C, p_expected_a: 20, p_expected_b: 30 } })
    await POST(reqOf("POST", body("down")), ctx(B))
    expect(h.fake.calls.rpc[1].args).toMatchObject({ p_a: B, p_b: A })
  })
  it("maps a stale ladder from the rpc to 409", async () => {
    h.fake.rpc.admin_role_swap_rank = { error: { message: "ranks changed, reload" } }
    const res = await POST(reqOf("POST", body("up")), ctx(B))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "The ladder changed. Reload and try again." })
  })
  it("409 at the end of the ladder; never swaps with user or admin", async () => {
    const down = await POST(reqOf("POST", body("down")), ctx(A))
    expect(down.status).toBe(409)
    expect(await down.json()).toEqual({ error: "Already at the end of the ladder." })
    expect((await POST(reqOf("POST", body("up")), ctx(C))).status).toBe(409)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("refuses to move dealer (400) and never swaps a custom role with dealer", async () => {
    for (const dir of ["up", "down"]) {
      const res = await POST(reqOf("POST", body(dir)), ctx(DEALER))
      expect(res.status).toBe(400)
    }
    // bronze (15) is directly above dealer (10): moving it down has nowhere to go
    const down = await POST(reqOf("POST", body("down")), ctx(A))
    expect(down.status).toBe(409)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("never moves a custom role at or below dealer (legacy role below dealer)", async () => {
    ;(h.fake.tables.roles as { data: unknown[] }).data.push(role("12121212-0000-4000-8000-000000000012", "legacy", 5))
    expect((await POST(reqOf("POST", body("down")), ctx(A))).status).toBe(409)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("fails closed with 500 when dealer is missing", async () => {
    const t = h.fake.tables.roles as { data: Array<{ slug: string }> }
    t.data = t.data.filter((r) => r.slug !== "dealer")
    expect((await POST(reqOf("POST", body("up")), ctx(B))).status).toBe(500)
    expect(h.fake.calls.rpc).toEqual([])
  })
  it("400 for moving user, bad direction, bad reason; 404 unknown role", async () => {
    expect((await POST(reqOf("POST", body("up")), ctx(U))).status).toBe(400)
    expect((await POST(reqOf("POST", body("sideways")), ctx(B))).status).toBe(400)
    expect((await POST(reqOf("POST", { direction: "up", reason: "x" }), ctx(B))).status).toBe(400)
    expect((await POST(reqOf("POST", body("up")), ctx("99999999-9999-4999-8999-999999999999"))).status).toBe(404)
  })
})
