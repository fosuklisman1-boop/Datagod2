import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  admin: true,
  calls: [] as Array<[string, string, unknown[]]>,
  conv: [] as any[],
  msgs: [] as any[],
  count: 0,
}))

function builder(table: string) {
  const mine: Array<[string, unknown[]]> = []
  const b: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") {
        return (res: (v: unknown) => void) => {
          if (table === "ai_conversations") return res({ data: h.conv, count: h.count, error: null })
          // Honour .in() / .eq("conversation_id") / .limit() like PostgREST would.
          let rows = h.msgs as any[]
          for (const [p, a] of mine) {
            if (p === "eq" && a[0] === "conversation_id") rows = rows.filter((m) => m.conversation_id === a[1])
            if (p === "in" && a[0] === "conversation_id") rows = rows.filter((m) => (a[1] as string[]).includes(m.conversation_id))
          }
          const lim = mine.find(([p]) => p === "limit")
          if (lim) rows = rows.slice(0, lim[1][0] as number)
          return res({ data: rows, error: null })
        }
      }
      return (...args: unknown[]) => { h.calls.push([table, prop, args]); mine.push([prop, args]); return b }
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

const get = (qs = "") => GET(new NextRequest(`http://localhost/api/admin/ai-conversations${qs}`))
const C1 = "11111111-aaaa-4bbb-8ccc-1234567890ab"

beforeEach(() => {
  h.admin = true; h.calls = []; h.count = 1
  h.conv = [{ id: C1, context: "home", user_id: "abcdef12-0000-4000-8000-000000000000", shop_id: null, started_at: "t0", last_at: "t1", message_count: 2, flagged: true, flag_reasons: ["refusal"], reviewed_at: null, reviewed_by: "adm" }]
  h.msgs = [{ conversation_id: C1, text: "x".repeat(300) }, { conversation_id: C1, text: "second" }]
})

describe("GET /api/admin/ai-conversations", () => {
  it("refuses non-admins with 403 and queries nothing", async () => {
    h.admin = false
    expect((await get()).status).toBe(403)
    expect(h.calls).toHaveLength(0)
  })

  it("rejects invalid query params with 400", async () => {
    expect((await get("?context=admin")).status).toBe(400)
    expect((await get("?page=-1")).status).toBe(400)
  })

  it("returns a privacy-safe row with a short preview and pagination", async () => {
    h.count = 51
    const body = await (await get("?page=2")).json()
    expect(body.page).toBe(2)
    expect(body.totalPages).toBe(3)
    const row = body.conversations[0]
    expect(row).toMatchObject({ id: C1, context: "home", audience: "Signed-in user", user: "abcdef12", flagged: true, flag_reasons: ["refusal"], message_count: 2 })
    expect(row.preview.length).toBe(120)
    expect(JSON.stringify(row)).not.toContain("abcdef12-0000")
    expect(row).not.toHaveProperty("user_id")
    expect(row).not.toHaveProperty("reviewed_by")
    expect(h.calls).toContainEqual(["ai_conversations", "range", [25, 49]])
    expect(h.calls).toContainEqual(["ai_conversations", "order", ["last_at", { ascending: false }]])
  })

  it("applies filters", async () => {
    await get("?context=storefront&flagged=true&reviewed=false&from=2026-11-01&to=2026-11-20")
    const c = h.calls.filter((x) => x[0] === "ai_conversations")
    expect(c).toContainEqual(["ai_conversations", "eq", ["context", "storefront"]])
    expect(c).toContainEqual(["ai_conversations", "eq", ["flagged", true]])
    expect(c).toContainEqual(["ai_conversations", "is", ["reviewed_at", null]])
    expect(c).toContainEqual(["ai_conversations", "gte", ["last_at", "2026-11-01T00:00:00.000Z"]])
    expect(c).toContainEqual(["ai_conversations", "lte", ["last_at", "2026-11-20T23:59:59.999Z"]])
  })
})

describe("previews", () => {
  it("every conversation on the page gets its preview even when one has many messages", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `c${i}`)
    h.count = 25
    h.conv = ids.map((id) => ({ id, context: "home", user_id: null, shop_id: null, started_at: "t0", last_at: "t1", message_count: 1, flagged: false, flag_reasons: [], reviewed_at: null }))
    // c0 is a long conversation whose rows come first; a capped single query would starve the rest.
    h.msgs = [
      ...Array.from({ length: 200 }, (_, i) => ({ conversation_id: "c0", text: `long ${i}` })),
      ...ids.slice(1).map((id) => ({ conversation_id: id, text: `first of ${id}` })),
    ]
    const body = await (await get()).json()
    expect(body.conversations[0].preview).toBe("long 0")
    for (const c of body.conversations.slice(1)) expect(c.preview).toBe(`first of ${c.id}`)
  })
})
