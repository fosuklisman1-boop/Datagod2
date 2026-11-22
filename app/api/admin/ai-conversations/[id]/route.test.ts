import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ admin: true, calls: [] as any[], conv: null as any, msgs: [] as any[] }))

function builder(table: string) {
  const b: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "maybeSingle") return async () => ({ data: h.conv, error: null })
      if (prop === "then") return (res: (v: unknown) => void) => res({ data: h.msgs, error: null })
      return (...args: unknown[]) => { h.calls.push([table, prop, args]); return b }
    },
  })
  return b
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => builder(t) }) }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () => h.admin
    ? { isAdmin: true, userId: "a", errorResponse: null }
    : { isAdmin: false, userId: null, errorResponse: new Response("no", { status: 403 }) },
}))

import { GET } from "./route"

const ID = "11111111-aaaa-4bbb-8ccc-1234567890ab"
const call = (id: string) => GET(new NextRequest(`http://localhost/api/admin/ai-conversations/${id}`), { params: Promise.resolve({ id }) })

beforeEach(() => {
  h.admin = true; h.calls = []
  h.conv = { id: ID, context: "dashboard", user_id: "abcdef12-0000-4000-8000-000000000000", shop_id: null, started_at: "t0", last_at: "t1", message_count: 2, flagged: false, flag_reasons: [], reviewed_at: null }
  h.msgs = [{ id: 1, role: "user", text: "my number is [phone]", created_at: "t0" }, { id: 2, role: "assistant", text: "ok", created_at: "t1" }]
})

describe("GET /api/admin/ai-conversations/[id]", () => {
  it("403 for non-admins, nothing queried", async () => {
    h.admin = false
    expect((await call(ID)).status).toBe(403)
    expect(h.calls).toHaveLength(0)
  })
  it("404 for an invalid uuid without querying", async () => {
    expect((await call("not-a-uuid")).status).toBe(404)
    expect(h.calls).toHaveLength(0)
  })
  it("404 when missing", async () => {
    h.conv = null
    expect((await call(ID)).status).toBe(404)
  })
  it("returns stored (redacted) text only, no identity fields", async () => {
    const body = await (await call(ID)).json()
    expect(body.messages.map((m: any) => m.text)).toEqual(["my number is [phone]", "ok"])
    expect(body.messages[0]).toEqual({ role: "user", text: "my number is [phone]", created_at: "t0" })
    expect(body.conversation).toMatchObject({ id: ID, audience: "Signed-in user", user: "abcdef12" })
    expect(JSON.stringify(body)).not.toContain("abcdef12-0000")
    expect(h.calls).toContainEqual(["ai_conversation_messages", "order", ["id", { ascending: true }]])
  })
})
