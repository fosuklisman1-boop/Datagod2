import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  rateAllowed: true,
  rateCalls: [] as unknown[][],
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

vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: async (...a: unknown[]) => { h.rateCalls.push(a.slice(1)); return { allowed: h.rateAllowed, remaining: 1, resetAt: 0 } },
}))

import { POST } from "./route"

const CALL = "11111111-1111-4111-8111-111111111111"
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/ai/voice/end", { method: "POST", body: JSON.stringify(body), headers })

beforeEach(() => {
  Object.assign(h, { user: null, row: null, updates: [], filters: [], rateAllowed: true, rateCalls: [] })
  process.env.NUANCE_DEVICE_SALT = "salt"
})

describe("POST /api/ai/voice/end", () => {
  it("bad body -> 400", async () => {
    expect((await POST(req({ callId: "nope", reason: "x" }))).status).toBe(400)
  })

  it("not the caller's row (or no identity) -> 404 and nothing written", async () => {
    h.user = { id: "u1" }
    h.row = null
    expect((await POST(req({ callId: CALL, reason: "user" }, { authorization: "Bearer j" }))).status).toBe(404)
    h.user = null
    expect((await POST(req({ callId: CALL, reason: "user" }))).status).toBe(404)
    expect(h.updates).toHaveLength(0)
  })

  it("the lookup is scoped to the caller's user id", async () => {
    h.user = { id: "u1" }
    h.row = { id: CALL, ended_at: null }
    await POST(req({ callId: CALL, reason: "user" }, { authorization: "Bearer j" }))
    expect(h.filters).toContainEqual(["eq", "user_id", "u1"])
  })

  it("ends an open call once: 204 with ended_at, reason, conversation id, started_at", async () => {
    h.user = { id: "u1" }
    h.row = { id: CALL, ended_at: null }
    const res = await POST(req({ callId: CALL, reason: "user", conversationId: "conv-1", started: true }, { authorization: "Bearer j" }))
    expect(res.status).toBe(204)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toMatchObject({ end_reason: "user", conversation_id: "conv-1" })
    expect(typeof h.updates[0].ended_at).toBe("string")
    expect(typeof h.updates[0].started_at).toBe("string")
  })

  it("second call -> 204 without re-writing ended_at", async () => {
    h.user = { id: "u1" }
    h.row = { id: CALL, ended_at: "2026-11-27T00:00:00Z" }
    const res = await POST(req({ callId: CALL, reason: "user" }, { authorization: "Bearer j" }))
    expect(res.status).toBe(204)
    expect(h.updates).toHaveLength(0)
  })

  it("a visitor is matched by device hash from the cookie", async () => {
    h.row = { id: CALL, ended_at: null }
    const res = await POST(req({ callId: CALL, reason: "user" }, { cookie: `dg_vdid=${"b".repeat(32)}` }))
    expect(res.status).toBe(204)
    expect(h.filters.some((f) => f[0] === "eq" && f[1] === "device_hash" && /^[a-f0-9]{32}$/.test(String(f[2])))).toBe(true)
  })

  it("C1: server-only and unknown reasons -> 400, nothing written (a client cannot dodge the daily caps)", async () => {
    h.user = { id: "u1" }
    h.row = { id: CALL, ended_at: null }
    for (const reason of ["cap_exceeded", "count_failed", "mint_credits", "made_up", "user hangup"]) {
      const res = await POST(req({ callId: CALL, reason }, { authorization: "Bearer j" }))
      expect(res.status, reason).toBe(400)
    }
    expect(h.updates).toHaveLength(0)
  })

  it("C1: every reason the client sends is accepted", async () => {
    h.user = { id: "u1" }
    h.row = { id: CALL, ended_at: null }
    for (const reason of ["user", "page_left", "ended", "connect_failed", "start_failed", "token_failed", "fallback", "content", "age_check", "policy-violation", "age-check", "expired", "end_call", "error", "connection_lost", "timeout"]) {
      expect((await POST(req({ callId: CALL, reason }, { authorization: "Bearer j" }))).status, reason).toBe(204)
    }
  })

  it("I7: rate limited per user (bucket ai_voice_end, 30/min, pg fallback); over the limit -> 429, nothing written", async () => {
    h.user = { id: "u1" }
    h.row = { id: CALL, ended_at: null }
    await POST(req({ callId: CALL, reason: "user" }, { authorization: "Bearer j" }))
    expect(h.rateCalls[0]).toEqual(["ai_voice_end", 30, 60_000, "u1", { pgFallback: true }])
    h.rateAllowed = false
    expect((await POST(req({ callId: CALL, reason: "user" }, { authorization: "Bearer j" }))).status).toBe(429)
    expect(h.updates).toHaveLength(1)
  })

  it("I7: a visitor is rate limited by device hash", async () => {
    h.row = { id: CALL, ended_at: null }
    await POST(req({ callId: CALL, reason: "user" }, { cookie: `dg_vdid=${"b".repeat(32)}` }))
    expect(String(h.rateCalls[0][3])).toMatch(/^[a-f0-9]{32}$/)
  })

  it("M1: started_at is the client's presented time, clamped to [created_at, now]", async () => {
    h.user = { id: "u1" }
    const created = new Date(Date.now() - 120_000).toISOString()
    const presented = new Date(Date.now() - 60_000).toISOString()
    h.row = { id: CALL, ended_at: null, created_at: created }
    await POST(req({ callId: CALL, reason: "user", started: true, startedAt: presented }, { authorization: "Bearer j" }))
    expect(h.updates[0].started_at).toBe(presented)
    // before created_at -> created_at
    await POST(req({ callId: CALL, reason: "user", started: true, startedAt: "2020-01-01T00:00:00.000Z" }, { authorization: "Bearer j" }))
    expect(h.updates[1].started_at).toBe(created)
    // in the future -> not after ended_at
    await POST(req({ callId: CALL, reason: "user", started: true, startedAt: "2999-01-01T00:00:00.000Z" }, { authorization: "Bearer j" }))
    expect(h.updates[2].started_at).toBe(h.updates[2].ended_at)
    // never presented -> no started_at
    await POST(req({ callId: CALL, reason: "user", started: false, startedAt: presented }, { authorization: "Bearer j" }))
    expect(h.updates[3].started_at).toBeUndefined()
  })
})
