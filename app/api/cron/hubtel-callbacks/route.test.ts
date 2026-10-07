// app/api/cron/hubtel-callbacks/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  inserts: [] as any[],
  deletes: [] as any[],
  deleteThrows: false,
  rows: [] as Array<{ session_id: string }>,
  dispatch: vi.fn(),
  send: vi.fn(),
}))

vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: (row: any) => { h.inserts.push({ table, row }); return Promise.resolve({ error: null }) },
      delete: () => ({
        lt: (column: string, value: string) => {
          if (h.deleteThrows) throw new Error("delete exploded")
          h.deletes.push({ table, column, value }); return Promise.resolve({ error: null })
        },
      }),
    }),
  }),
}))
vi.mock("@/lib/ussd-hubtel/tx-store", () => ({ createSupabaseTxStore: () => ({ listPendingCallbacks: async () => h.rows }) }))
vi.mock("@/lib/ussd-hubtel/callbacks", () => ({ dispatchCallback: (...a: any[]) => h.dispatch(...a) }))
vi.mock("@/lib/ussd-hubtel/relay", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/ussd-hubtel/relay")>()),
  sendFulfillmentCallback: (...a: any[]) => h.send(...a),
}))

import { GET } from "./route"

beforeEach(() => {
  h.inserts = []; h.deletes = []; h.deleteThrows = false
  h.rows = [{ session_id: "S1" }, { session_id: "S2" }]
  h.dispatch.mockReset().mockImplementation(async (_s: unknown, send: any, sid: string) => {
    const r = await send({ sessionId: sid, orderId: `O-${sid}` })
    return r.ok ? "sent" : "retry"
  })
  h.send.mockReset().mockImplementation(async (p: { sessionId: string }) =>
    p.sessionId === "S1" ? { ok: true, upstreamStatus: 200, upstreamBody: {} } : { ok: false, error: "relay/hubtel 500: null", upstreamStatus: 500 })
})

describe("cron hubtel-callbacks: callback log", () => {
  it("logs every attempt (sent and failed) and keeps the response shape", async () => {
    const res = await GET(new NextRequest("http://localhost/api/cron/hubtel-callbacks"))
    expect(await res.json()).toEqual({ listed: 2, processed: 2, sent: 1, retry: 1 })
    const out = h.inserts.filter(i => i.table === "hubtel_callback_logs").map(i => i.row)
    expect(out).toEqual([
      expect.objectContaining({ direction: "outbound_callback", session_id: "S1", outcome: "sent", ok: true, http_status: 200 }),
      expect.objectContaining({ direction: "outbound_callback", session_id: "S2", outcome: "failed", ok: false, http_status: 500 }),
    ])
  })
  it("purges logs older than 30 days once per run", async () => {
    await GET(new NextRequest("http://localhost/api/cron/hubtel-callbacks"))
    expect(h.deletes).toHaveLength(1)
    expect(h.deletes[0]).toMatchObject({ table: "hubtel_callback_logs", column: "created_at" })
    const cutoff = Date.parse(h.deletes[0].value)
    expect(Math.abs(Date.now() - 30 * 86_400_000 - cutoff)).toBeLessThan(60_000)
  })
  it("a purge failure does not change the response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.deleteThrows = true
    const res = await GET(new NextRequest("http://localhost/api/cron/hubtel-callbacks"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ listed: 2, processed: 2, sent: 1, retry: 1 })
  })
})
