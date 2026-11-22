import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ admin: true, calls: [] as any[], conv: null as any }))

function builder(table: string) {
  const b: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "maybeSingle") return async () => ({ data: h.conv, error: null })
      if (prop === "then") return (res: (v: unknown) => void) => res({ data: null, error: null })
      return (...args: unknown[]) => { h.calls.push([table, prop, args]); return b }
    },
  })
  return b
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => builder(t) }) }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () => h.admin
    ? { isAdmin: true, userId: "admin-1", errorResponse: null }
    : { isAdmin: false, userId: null, errorResponse: new Response("no", { status: 403 }) },
}))

import { POST } from "./route"

const ID = "11111111-aaaa-4bbb-8ccc-1234567890ab"
const call = (id: string) => POST(new NextRequest(`http://localhost/api/admin/ai-conversations/${id}/review`, { method: "POST" }), { params: Promise.resolve({ id }) })
const updates = () => h.calls.filter((c) => c[1] === "update")

beforeEach(() => { h.admin = true; h.calls = []; h.conv = { id: ID, reviewed_at: null } })

describe("POST review", () => {
  it("403 for non-admins and writes nothing", async () => {
    h.admin = false
    expect((await call(ID)).status).toBe(403)
    expect(h.calls).toHaveLength(0)
  })
  it("404 for an invalid uuid or a missing row", async () => {
    expect((await call("zzz")).status).toBe(404)
    h.conv = null
    expect((await call(ID)).status).toBe(404)
    expect(updates()).toHaveLength(0)
  })
  it("sets reviewed_at and reviewed_by", async () => {
    const res = await call(ID)
    expect(res.status).toBe(200)
    expect(updates()).toHaveLength(1)
    const patch = updates()[0][2][0]
    expect(patch.reviewed_by).toBe("admin-1")
    expect(typeof patch.reviewed_at).toBe("string")
  })
  it("is idempotent: an already-reviewed row is not rewritten", async () => {
    h.conv = { id: ID, reviewed_at: "2026-11-20T00:00:00Z" }
    const body = await (await call(ID)).json()
    expect(body).toMatchObject({ ok: true, reviewed_at: "2026-11-20T00:00:00Z" })
    expect(updates()).toHaveLength(0)
  })
})
