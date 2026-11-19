import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ADMIN, role } from "../../test-utils"

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  change: vi.fn(),
  fake: null as unknown as ReturnType<typeof makeFake>,
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
vi.mock("@/lib/admin-users/account-ops", () => ({ changeUserRole: h.change }))
import { NextResponse } from "next/server"
import { POST } from "./route"

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const [U1, U2, U3, U4] = [uid(1), uid(2), uid(3), uid(4)]
const body = (o: Record<string, unknown> = {}) => ({ user_ids: [U1], to_role: "gold", reason: "promo", ...o })
const post = (b: unknown) => POST(reqOf("POST", b, "http://localhost/api/admin/roles/members/move"))

beforeEach(() => {
  h.fake = makeFake()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.change.mockReset()
  h.change.mockResolvedValue({ ok: true, changed: true, oldRole: "user", newRole: "gold", audited: true })
  h.fake.tables.roles = {
    data: [
      role("aaaaaaaa-0000-4000-8000-000000000001", "user", 0, { is_system: true }),
      role("aaaaaaaa-0000-4000-8000-000000000002", "gold", 30),
      role("aaaaaaaa-0000-4000-8000-000000000003", "old", 40, { archived_at: "2026-01-01" }),
      role("aaaaaaaa-0000-4000-8000-000000000004", "admin", null, { is_system: true }),
      role("aaaaaaaa-0000-4000-8000-000000000005", "sub_agent", null, { is_system: true }),
    ],
  }
  h.fake.tables.users = ({ filters }) => {
    const ids = (filters.find((f) => f[0] === "in")?.[2] as string[]) ?? []
    const rows: Record<string, string | null> = { [U1]: "user", [U2]: "user", [U3]: "admin", [U4]: null }
    return { data: ids.filter((i) => i in rows).map((id) => ({ id, role: rows[id] })) }
  }
})

describe("POST /api/admin/roles/members/move", () => {
  it("401 / 403 CRON bypass", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await post(body())).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true })
    expect((await post(body())).status).toBe(403)
    expect(h.change).not.toHaveBeenCalled()
  })
  it("400 before anyone is processed: admin / sub_agent / archived / unknown target, 201 ids, bad reason, bad uuid", async () => {
    const many = Array.from({ length: 201 }, (_, i) => uid(i + 1))
    for (const b of [
      body({ to_role: "admin" }), body({ to_role: "sub_agent" }), body({ to_role: "old" }), body({ to_role: "nope" }),
      body({ user_ids: many }), body({ user_ids: [] }), body({ reason: "x" }), body({ user_ids: ["zzz"] }),
    ]) {
      expect((await post(b)).status).toBe(400)
    }
    expect((await POST(reqOf("POST", undefined, "http://localhost/x"))).status).toBe(400)
    expect(h.change).not.toHaveBeenCalled()
    expect(h.fake.calls.from).not.toContain("users")
  })
  it("mixed batch: per-user outcomes in input order, reason passed to changeUserRole", async () => {
    h.change
      .mockResolvedValueOnce({ ok: true, changed: true, oldRole: "user", newRole: "gold", audited: true, note: "2 shop packages hit a 0 margin" })
      .mockResolvedValueOnce({ ok: true, changed: false, oldRole: "gold", newRole: "gold", audited: false })
      .mockResolvedValueOnce({ ok: false, status: 400, error: "Sub-agents cannot be upgraded to this role." })
    // U4 has a NULL role (counts as user) so it is processed; U3 is admin; uid(99) does not exist.
    const res = await post(body({ user_ids: [U1, U2, U4, U3, uid(99)] }))
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual([
      { user_id: U1, status: "moved", note: "2 shop packages hit a 0 margin" },
      { user_id: U2, status: "skipped", reason: "already in role" },
      { user_id: U4, status: "skipped", reason: "Sub-agents cannot be upgraded to this role." },
      { user_id: U3, status: "skipped", reason: "Admin accounts can't be moved here." },
      { user_id: uid(99), status: "skipped", reason: "User not found" },
    ])
    expect(h.change.mock.calls.map((c) => c[1])).toEqual([
      { userId: U1, role: "gold", adminId: ADMIN, reason: "promo" },
      { userId: U2, role: "gold", adminId: ADMIN, reason: "promo" },
      { userId: U4, role: "gold", adminId: ADMIN, reason: "promo" },
    ])
  })
  it("dedups ids and processes sequentially", async () => {
    let running = 0
    let peak = 0
    h.change.mockImplementation(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { ok: true, changed: true, oldRole: "user", newRole: "gold", audited: true }
    })
    await post(body({ user_ids: [U1, U2, U1] }))
    expect(h.change).toHaveBeenCalledTimes(2)
    expect(peak).toBe(1)
  })
  it("a throwing user is an error for that user only, with a generic reason", async () => {
    h.change.mockRejectedValueOnce(new Error("db password leaked in message"))
    const res = await post(body({ user_ids: [U1, U2] }))
    const { results } = await res.json()
    expect(results).toEqual([
      { user_id: U1, status: "error", reason: "Something went wrong" },
      { user_id: U2, status: "moved" },
    ])
    expect(JSON.stringify(results)).not.toContain("password")
  })
  it("fails closed: the up-front role read fails -> 500, nobody processed", async () => {
    h.fake.tables.users = { error: { message: "boom" } }
    const res = await post(body({ user_ids: [U1, U2] }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Something went wrong" })
    expect(h.change).not.toHaveBeenCalled()
  })
  it("reads current roles in one chunked query, not per user", async () => {
    await post(body({ user_ids: [U1, U2, U3] }))
    expect(h.fake.calls.chains.users).toHaveLength(1)
  })
})
