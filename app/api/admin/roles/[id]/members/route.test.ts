import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFake, reqOf, ctx, ADMIN, role } from "../../test-utils"

const h = vi.hoisted(() => ({ verify: vi.fn(), fake: null as unknown as ReturnType<typeof makeFake> }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake.db }))
import { NextResponse } from "next/server"
import { GET } from "./route"

const USER_R = "eeeeeeee-0000-4000-8000-000000000005"
const GOLD = "cccccccc-0000-4000-8000-000000000003"
const ADMIN_R = "ffffffff-0000-4000-8000-000000000006"
const MISSING = "99999999-9999-4999-8999-999999999999"
const get = (qs = "") => reqOf("GET", undefined, `http://localhost/api/admin/roles/x/members${qs}`)
const usersChain = () => h.fake.calls.chains.users[0]
const ors = () => usersChain().filter((f) => f[0] === "or").map((f) => f[1] as string)

beforeEach(() => {
  h.fake = makeFake()
  h.verify.mockReset()
  h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  h.fake.tables.roles = {
    data: [role(USER_R, "user", 0, { is_system: true }), role(GOLD, "gold", 30), role(ADMIN_R, "admin", null, { is_system: true })],
  }
  h.fake.tables.users = {
    data: [{ id: "u1", first_name: "Ama", last_name: "Mensah", email: "a@x.com", phone_number: "0244000001", role: "gold", secret: "x" }],
    count: 120,
  }
})

describe("GET /api/admin/roles/[id]/members", () => {
  it("401 / 403 CRON bypass", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await GET(get(), ctx(GOLD))).status).toBe(401)
    h.verify.mockResolvedValue({ isAdmin: true })
    expect((await GET(get(), ctx(GOLD))).status).toBe(403)
    expect(h.fake.calls.from).toEqual([])
  })
  it("returns name/email/phone only, the exact total and the page", async () => {
    const res = await GET(get("?page=2"), ctx(GOLD))
    expect(await res.json()).toEqual({
      members: [{ id: "u1", name: "Ama Mensah", email: "a@x.com", phone: "0244000001" }],
      total: 120,
      page: 2,
    })
    const c = usersChain()
    expect(c).toContainEqual(["select", "id, first_name, last_name, email, phone_number", { count: "exact" }])
    expect(c).toContainEqual(["eq", "role", "gold"])
    expect(c).toContainEqual(["range", 50, 99])
  })
  it("clamps the page to 1..1000", async () => {
    expect((await (await GET(get("?page=-4"), ctx(GOLD))).json()).page).toBe(1)
    expect((await (await GET(get("?page=abc"), ctx(GOLD))).json()).page).toBe(1)
    expect((await (await GET(get("?page=999999"), ctx(GOLD))).json()).page).toBe(1000)
  })
  it("members of user include role IS NULL", async () => {
    await GET(get(), ctx(USER_R))
    expect(ors()).toEqual(["role.is.null,role.eq.user"])
  })
  it("admin members may be listed (read only)", async () => {
    const res = await GET(get(), ctx(ADMIN_R))
    expect(res.status).toBe(200)
    expect(usersChain()).toContainEqual(["eq", "role", "admin"])
  })
  it("search: strips % (outside the allowed alphabet), escapes _, quotes values, matches name/email/phone", async () => {
    await GET(get("?q=" + encodeURIComponent("50%_x")), ctx(GOLD))
    const [f] = ors()
    expect(f).toContain('first_name.ilike."%50\\\\_x%"')
    for (const col of ["first_name", "last_name", "email", "phone_number"]) expect(f).toContain(`${col}.ilike.`)
  })
  it("search injection: commas, parens, quotes, backslashes and dots cannot widen the filter", async () => {
    await GET(get("?q=" + encodeURIComponent("a,role.eq.admin")), ctx(GOLD))
    const [f] = ors()
    expect(f).toBe(["first_name", "last_name", "email", "phone_number"].map((c) => `${c}.ilike."%arole.eq.admin%"`).join(","))
    h.fake.calls.chains.users = []
    await GET(get("?q=" + encodeURIComponent('"),role.eq.admin,(x\\')), ctx(GOLD))
    const [g] = ors()
    expect(g.split(",")).toHaveLength(4)
    expect(g).not.toMatch(/[()\\]/)
    expect(g.match(/"/g)).toHaveLength(8)
  })
  it("empty q after cleaning means no search filter; q is capped at 64 chars", async () => {
    await GET(get("?q=" + encodeURIComponent(',()"')), ctx(GOLD))
    expect(ors()).toEqual([])
    h.fake.calls.chains.users = []
    await GET(get("?q=" + "a".repeat(100)), ctx(GOLD))
    expect(ors()[0]).toContain(`"%${"a".repeat(64)}%"`)
    expect(ors()[0]).not.toContain("a".repeat(65))
  })
  it("404 unknown role, 400 bad id; 500 generic when the read fails", async () => {
    expect((await GET(get(), ctx(MISSING))).status).toBe(404)
    expect((await GET(get(), ctx("nope"))).status).toBe(400)
    h.fake.tables.users = { error: { message: "secret db detail" } }
    const res = await GET(get(), ctx(GOLD))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Something went wrong" })
  })
})
