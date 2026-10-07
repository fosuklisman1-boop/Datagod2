// app/api/ussd-hubtel/fulfillment/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  inserts: [] as Array<{ table: string; row: any }>,
  insertResult: { error: null } as unknown,
  insertThrows: false,
  insertHangs: false,
  afterThrows: false,
  process: vi.fn(),
  dispatch: vi.fn(),
  send: vi.fn(),
}))

vi.mock("next/server", async importOriginal => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    if (h.afterThrows) throw new Error("after() unavailable")
    h.afterTasks.push(fn)
  },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: (row: any) => {
        if (h.insertThrows) throw new Error("insert exploded")
        h.inserts.push({ table, row })
        return h.insertHangs ? new Promise(() => {}) : Promise.resolve(h.insertResult)
      },
    }),
  }),
}))
vi.mock("@/lib/ussd-hubtel/payment", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/ussd-hubtel/payment")>()), // real parseFulfillmentPayload
  processFulfillment: (...a: any[]) => h.process(...a),
}))
vi.mock("@/lib/ussd-hubtel/tx-store", () => ({ createSupabaseTxStore: () => ({ kind: "store" }) }))
vi.mock("@/lib/ussd-hubtel/order-handlers", () => ({ createOrderHandlers: () => ({}) }))
vi.mock("@/lib/ussd-hubtel/callbacks", () => ({ dispatchCallback: (...a: any[]) => h.dispatch(...a) }))
vi.mock("@/lib/ussd-hubtel/relay", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/ussd-hubtel/relay")>()),
  sendFulfillmentCallback: (...a: any[]) => h.send(...a),
}))

import { POST } from "./route"
import { __resetCallbackLogWarningsForTests } from "@/lib/ussd-hubtel/callback-log"

const SECRET = "s3cret-fulfil"
const PAYLOAD = {
  SessionId: "S1", OrderId: "H1",
  OrderInfo: { CustomerName: "Kwame", CustomerMobileNumber: "233244123456", Payment: { AmountPaid: 10.2, AmountAfterCharges: 10, IsSuccessful: true } },
}
const post = (body: string, opts: { secret?: string | null; ip?: string } = {}) => {
  const secret = opts.secret === undefined ? SECRET : opts.secret
  const url = `http://localhost/api/ussd-hubtel/fulfillment${secret ? `?secret=${secret}` : ""}`
  return new NextRequest(url, { method: "POST", body, headers: opts.ip ? { "x-forwarded-for": opts.ip } : {} })
}
const runAfter = async () => { const tasks = h.afterTasks.splice(0); for (const t of tasks) await t() }
const logs = () => h.inserts.filter(i => i.table === "hubtel_callback_logs").map(i => i.row)

beforeEach(() => {
  vi.stubEnv("HUBTEL_WEBHOOK_SECRET", SECRET)
  vi.stubEnv("HUBTEL_ENFORCE_FULFILLMENT_IP", "")
  h.afterTasks = []; h.inserts = []; h.insertResult = { error: null }; h.insertThrows = false; h.insertHangs = false; h.afterThrows = false
  h.process.mockReset().mockResolvedValue("fulfilled")
  h.dispatch.mockReset().mockImplementation(async (_store: unknown, send: any, sid: string) => { await send({ sessionId: sid, orderId: "H1" }); return "sent" })
  h.send.mockReset().mockResolvedValue({ ok: true, upstreamStatus: 200, upstreamBody: { ResponseCode: "0000" } })
  __resetCallbackLogWarningsForTests()
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe("POST /api/ussd-hubtel/fulfillment: responses unchanged", () => {
  it("valid payload: 200 {received, outcome}; one inbound log with the outcome and the parsed payload", async () => {
    const res = await POST(post(JSON.stringify(PAYLOAD), { ip: "52.50.116.54" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, outcome: "fulfilled" })
    await runAfter()
    const inbound = logs().filter(r => r.direction === "inbound_fulfillment")
    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toMatchObject({
      session_id: "S1", hubtel_order_id: "H1", outcome: "fulfilled", ok: true, payload: PAYLOAD, raw_body: null, source_ip: "52.50.116.54",
    })
  })
  it("the immediate callback is logged outbound", async () => {
    await POST(post(JSON.stringify(PAYLOAD)))
    await runAfter()
    const out = logs().filter(r => r.direction === "outbound_callback")
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      session_id: "S1", hubtel_order_id: "H1", outcome: "sent", ok: true, http_status: 200,
      payload: { SessionId: "S1", OrderId: "H1", ServiceStatus: "success", MetaData: null },
    })
  })
  it("duplicate: 200 and logged with outcome duplicate, no callback", async () => {
    h.process.mockResolvedValue("duplicate")
    const res = await POST(post(JSON.stringify(PAYLOAD)))
    expect(await res.json()).toEqual({ received: true, outcome: "duplicate" })
    await runAfter()
    expect(logs()).toEqual([expect.objectContaining({ direction: "inbound_fulfillment", outcome: "duplicate", ok: true })])
    expect(h.dispatch).not.toHaveBeenCalled()
  })
  it("needs_review and unknown_session are logged as problems (ok=false)", async () => {
    for (const outcome of ["needs_review", "unknown_session"]) {
      h.inserts = []
      h.process.mockResolvedValue(outcome)
      vi.spyOn(console, "error").mockImplementation(() => {})
      const res = await POST(post(JSON.stringify(PAYLOAD)))
      expect(res.status).toBe(200)
      await runAfter()
      expect(logs().find(r => r.direction === "inbound_fulfillment")).toMatchObject({ outcome, ok: false })
    }
  })
  it("invalid JSON: 400 {error:'Invalid JSON'}; logged as parse_error with the raw body", async () => {
    const res = await POST(post("{not json"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Invalid JSON" })
    await runAfter()
    expect(logs()).toEqual([expect.objectContaining({
      direction: "inbound_fulfillment", outcome: "parse_error", ok: false, payload: null, raw_body: "{not json",
    })])
    expect(h.process).not.toHaveBeenCalled()
  })
  it("invalid payload: 400 {error:'Invalid payload'}; logged as invalid_payload with the parsed payload", async () => {
    const bad = { SessionId: "S9", OrderId: "H9", OrderInfo: {} }
    const res = await POST(post(JSON.stringify(bad)))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Invalid payload" })
    await runAfter()
    expect(logs()).toEqual([expect.objectContaining({
      outcome: "invalid_payload", ok: false, session_id: "S9", hubtel_order_id: "H9", payload: bad, raw_body: null,
    })])
  })
  it("processing throws: the error still propagates (unchanged) and an 'error' log is scheduled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const boom = new Error("db down")
    h.process.mockRejectedValue(boom)
    await expect(POST(post(JSON.stringify(PAYLOAD)))).rejects.toBe(boom)
    await runAfter()
    expect(logs()).toEqual([expect.objectContaining({ outcome: "error", ok: false, session_id: "S1", error: "db down" })])
  })
  it("log failure or missing table: response unchanged, nothing thrown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const setup of [
      () => { h.insertThrows = true },
      () => { h.insertResult = { error: { code: "42P01", message: "relation does not exist" } } },
    ]) {
      setup()
      const res = await POST(post(JSON.stringify(PAYLOAD)))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ received: true, outcome: "fulfilled" })
      await expect(runAfter()).resolves.toBeUndefined()
      expect(h.dispatch).toHaveBeenCalled()
      h.insertThrows = false
    }
  })
  it("unauthorized (wrong/missing secret): 401 and NOT logged", async () => {
    for (const secret of ["wrong", null]) {
      const res = await POST(post(JSON.stringify(PAYLOAD), { secret }))
      expect(res.status).toBe(401)
    }
    await runAfter()
    expect(logs()).toEqual([])
  })
  it("IP not allowed (enforced): 403 and NOT logged", async () => {
    vi.stubEnv("HUBTEL_ENFORCE_FULFILLMENT_IP", "true")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await POST(post(JSON.stringify(PAYLOAD), { ip: "1.2.3.4" }))
    expect(res.status).toBe(403)
    await runAfter()
    expect(logs()).toEqual([])
  })
  it("after() throwing while scheduling a log: responses unchanged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.afterThrows = true
    h.process.mockResolvedValue("duplicate") // no callback after(): every after() call here is a log
    const ok = await POST(post(JSON.stringify(PAYLOAD)))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ received: true, outcome: "duplicate" })
    const bad = await POST(post("{nope"))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: "Invalid JSON" })
    const invalid = await POST(post(JSON.stringify({ SessionId: "S" })))
    expect(invalid.status).toBe(400)
  })
  it("no secret configured: 503 and nothing logged", async () => {
    vi.stubEnv("HUBTEL_WEBHOOK_SECRET", "")
    const res = await POST(post(JSON.stringify(PAYLOAD)))
    expect(res.status).toBe(503)
    await runAfter()
    expect(logs()).toEqual([])
    expect(h.afterTasks).toEqual([])
  })
  it("a hanging log insert does not delay the webhook response", async () => {
    h.insertHangs = true
    const res = await POST(post(JSON.stringify(PAYLOAD)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, outcome: "fulfilled" })
  })
  it("the immediate callback flushes its log after dispatchCallback returns (log not in the send-to-sent gap)", async () => {
    let dispatched = false
    h.dispatch.mockImplementation(async (_s: unknown, send: any, sid: string) => {
      await send({ sessionId: sid, orderId: "H1" })
      dispatched = true
      return "sent"
    })
    h.insertHangs = true
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      await POST(post(JSON.stringify(PAYLOAD)))
      const tasks = h.afterTasks.splice(0)
      const all = Promise.all(tasks.map(t => t()))
      await vi.advanceTimersByTimeAsync(0)
      expect(dispatched).toBe(true) // dispatch finished while the insert still hangs
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(all).resolves.toBeDefined()
    } finally { vi.useRealTimers() }
  })
  it("unknown_session: ok=false only when money was taken (IsSuccessful=true)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.process.mockResolvedValue("unknown_session")
    const unpaid = { ...PAYLOAD, OrderInfo: { ...PAYLOAD.OrderInfo, Payment: { ...PAYLOAD.OrderInfo.Payment, IsSuccessful: false } } }
    await POST(post(JSON.stringify(unpaid)))
    await POST(post(JSON.stringify(PAYLOAD)))
    await runAfter()
    expect(logs().map(r => [r.outcome, r.ok])).toEqual([["unknown_session", true], ["unknown_session", false]])
  })
  it("never stores the secret, URL or headers", async () => {
    await POST(post(JSON.stringify(PAYLOAD), { ip: "52.50.116.54" }))
    await POST(post("garbage"))
    await runAfter()
    const all = JSON.stringify(h.inserts)
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain("?secret")
    expect(all).not.toContain("x-forwarded-for")
  })
})
