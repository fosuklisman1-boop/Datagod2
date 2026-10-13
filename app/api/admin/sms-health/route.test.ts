import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  auth: { isAdmin: true } as any,
  rpc: {} as Record<string, () => Promise<{ data: unknown; error: { message: string } | null }>>,
  calls: [] as { fn: string; args: unknown }[],
  breaker: null as unknown,
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (fn: string, args: unknown) => {
      h.calls.push({ fn, args })
      const impl = h.rpc[fn]
      return impl ? impl() : Promise.resolve({ data: null, error: { message: `function ${fn} does not exist` } })
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.breaker, error: null }) }) }) }),
  }),
}))

import { GET } from "./route"

const req = (q = "") => new NextRequest(`http://localhost/api/admin/sms-health${q}`)
const healthPayload = {
  window_hours: 24,
  overall: { total: 3, delivered: 1, failed: 1, sent: 1, pending: 0 },
  by_type: [], by_provider: [],
  recent_failures: [{ phone_number: "233241234567", message_type: "phone_otp", error_message: "x", created_at: "2026-10-13T00:00:00Z" }],
}
const senderRows = [
  { sender: "OK", total: 20, delivered: 18, failed: 2, in_flight: 0, delivery_rate: 0.9, registry_status: "active" },
  { sender: "LINKSTOREGH", total: 100, delivered: 0, failed: 95, in_flight: 5, delivery_rate: 0, registry_status: "active" },
]

beforeEach(() => {
  h.auth = { isAdmin: true }
  h.calls = []
  h.breaker = null
  h.rpc = {
    sms_health: async () => ({ data: structuredClone(healthPayload), error: null }),
    sms_sender_health: async () => ({ data: structuredClone(senderRows), error: null }),
  }
})

describe("GET /api/admin/sms-health", () => {
  it("non-admin gets the guard's error response and no RPC runs", async () => {
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
    const res = (await GET(req()))!
    expect(res.status).toBe(403)
    expect(h.calls).toEqual([])
  })

  it("keeps the existing payload (masked phones, otp_breaker) and adds sender_health with a computed status", async () => {
    const res = (await GET(req("?hours=72")))!
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.success).toBe(true)
    expect(d.overall).toEqual(healthPayload.overall)
    expect(d.recent_failures[0].phone_number).toBe("233****67")
    expect(d.otp_breaker).toEqual({ open: false, until: null })
    expect(h.calls).toEqual([
      { fn: "sms_health", args: { p_hours: 72 } },
      { fn: "sms_sender_health", args: { p_hours: 72 } },
    ])
    expect(d.sender_health.map((r: any) => [r.sender, r.status])).toEqual([
      ["LINKSTOREGH", "not_delivering"],
      ["OK", "healthy"],
    ])
    expect(d.sender_health_error).toBeUndefined()
  })

  it("invalid hours falls back to 24 for both RPCs", async () => {
    (await GET(req("?hours=5")))!
    expect(h.calls.map((c) => c.args)).toEqual([{ p_hours: 24 }, { p_hours: 24 }])
  })

  it("sender RPC missing ⇒ sender_health null + error text, everything else intact", async () => {
    delete h.rpc.sms_sender_health
    const res = (await GET(req()))!
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.sender_health).toBeNull()
    expect(d.sender_health_error).toMatch(/sms_sender_health/)
    expect(d.overall).toEqual(healthPayload.overall)
    expect(d.recent_failures[0].phone_number).toBe("233****67")
  })

  it("sender RPC throwing ⇒ sender_health null, page still 200", async () => {
    h.rpc.sms_sender_health = async () => { throw new Error("boom") }
    const res = (await GET(req()))!
    expect(res.status).toBe(200)
    const d = await res.json()
    expect(d.sender_health).toBeNull()
    expect(d.sender_health_error).toMatch(/boom/)
  })

  it("main RPC error still returns 503 (unchanged)", async () => {
    h.rpc.sms_health = async () => ({ data: null, error: { message: "nope" } })
    const res = (await GET(req()))!
    expect(res.status).toBe(503)
    const d = await res.json()
    expect(d.error).toMatch(/sms_health_panel\.sql/)
  })
})
