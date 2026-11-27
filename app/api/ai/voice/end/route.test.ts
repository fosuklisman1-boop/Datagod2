import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  row: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  filters: [] as unknown[][],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => (h.user ? { data: { user: h.user }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: () => {
      const b: any = {}
      for (const m of ["select", "eq", "is"]) b[m] = (...a: unknown[]) => { h.filters.push([m, ...a]); return b }
      b.update = (v: Record<string, unknown>) => { h.updates.push(v); return b }
      b.maybeSingle = async () => ({ data: h.row, error: null })
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res)
      return b
    },
  }),
}))

import { POST } from "./route"

const CALL = "11111111-1111-4111-8111-111111111111"
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/ai/voice/end", { method: "POST", body: JSON.stringify(body), headers })

beforeEach(() => {
  Object.assign(h, { user: null, row: null, updates: [], filters: [] })
  process.env.NUANCE_DEVICE_SALT = "salt"
})

describe("POST /api/ai/voice/end", () => {
  it("bad body -> 400", async () => {
    expect((await POST(req({ callId: "nope", reason: "x" }))).status).toBe(400)
  })

  it("not the caller's row (or no identity) -> 404 and nothing written", async () => {
    h.user = { id: "u1" }
    h.row = null
    expect((await POST(req({ callId: CALL, reason: "user_hangup" }, { authorization: "Bearer j" }))).status).toBe(404)
    h.user = null
    expect((await POST(req({ callId: CALL, reason: "user_hangup" }))).status).toBe(404)
    expect(h.updates).toHaveLength(0)
  })

  it("the lookup is scoped to the caller's user id", async () => {
    h.user = { id: "u1" }
    h.row = { id: CALL, ended_at: null }
    await POST(req({ callId: CALL, reason: "user_hangup" }, { authorization: "Bearer j" }))
    expect(h.filters).toContainEqual(["eq", "user_id", "u1"])
  })

  it("ends an open call once: 204 with ended_at, reason, conversation id, started_at", async () => {
    h.user = { id: "u1" }
    h.row = { id: CALL, ended_at: null }
    const res = await POST(req({ callId: CALL, reason: "user_hangup", conversationId: "conv-1", started: true }, { authorization: "Bearer j" }))
    expect(res.status).toBe(204)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toMatchObject({ end_reason: "user_hangup", conversation_id: "conv-1" })
    expect(typeof h.updates[0].ended_at).toBe("string")
    expect(typeof h.updates[0].started_at).toBe("string")
  })

  it("second call -> 204 without re-writing ended_at", async () => {
    h.user = { id: "u1" }
    h.row = { id: CALL, ended_at: "2026-11-27T00:00:00Z" }
    const res = await POST(req({ callId: CALL, reason: "again" }, { authorization: "Bearer j" }))
    expect(res.status).toBe(204)
    expect(h.updates).toHaveLength(0)
  })

  it("a visitor is matched by device hash from the cookie", async () => {
    h.row = { id: CALL, ended_at: null }
    const res = await POST(req({ callId: CALL, reason: "x" }, { cookie: `dg_vdid=${"b".repeat(32)}` }))
    expect(res.status).toBe(204)
    expect(h.filters.some((f) => f[0] === "eq" && f[1] === "device_hash" && /^[a-f0-9]{32}$/.test(String(f[2])))).toBe(true)
  })
})
