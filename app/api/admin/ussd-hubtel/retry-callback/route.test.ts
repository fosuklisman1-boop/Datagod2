// app/api/admin/ussd-hubtel/retry-callback/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  auth: { isAdmin: true, userId: "admin-1" } as any,
  inserts: [] as any[],
  dispatch: vi.fn(),
  send: vi.fn(),
}))

vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({ insert: (row: any) => { h.inserts.push({ table, row }); return Promise.resolve({ error: null }) } }),
  }),
}))
vi.mock("@/lib/ussd-hubtel/tx-store", () => ({
  createSupabaseTxStore: () => ({
    findBySession: async () => ({ session_id: "S1", state: "fulfilled", callback_status: "pending" }),
    update: async () => {},
  }),
}))
vi.mock("@/lib/ussd-hubtel/callbacks", () => ({ dispatchCallback: (...a: any[]) => h.dispatch(...a) }))
vi.mock("@/lib/ussd-hubtel/relay", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/ussd-hubtel/relay")>()),
  sendFulfillmentCallback: (...a: any[]) => h.send(...a),
}))

import { POST } from "./route"

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/ussd-hubtel/retry-callback", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  h.auth = { isAdmin: true, userId: "admin-1" }
  h.inserts = []
  h.dispatch.mockReset().mockImplementation(async (_s: unknown, send: any, sid: string) => {
    const r = await send({ sessionId: sid, orderId: "H1" })
    return r.ok ? "sent" : "retry"
  })
  h.send.mockReset().mockResolvedValue({ ok: false, error: "relay/hubtel 400: null", upstreamStatus: 400 })
})

describe("POST /api/admin/ussd-hubtel/retry-callback: callback log", () => {
  it("the manual retry attempt is logged outbound; response unchanged", async () => {
    const res = await POST(post({ sessionId: "S1" }))
    expect(await res.json()).toEqual({ result: "retry" })
    expect(h.inserts.map(i => i.row)).toEqual([
      expect.objectContaining({ direction: "outbound_callback", session_id: "S1", outcome: "failed", ok: false, http_status: 400 }),
    ])
  })
  it("429 passthrough: nothing sent or logged", async () => {
    const { NextResponse } = await import("next/server")
    h.auth = { isAdmin: true, userId: "admin-1", errorResponse: NextResponse.json({ error: "slow down" }, { status: 429 }) }
    const res = await POST(post({ sessionId: "S1" }))
    expect(res.status).toBe(429)
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.inserts).toEqual([])
  })
})
