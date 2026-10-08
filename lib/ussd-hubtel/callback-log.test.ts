// lib/ussd-hubtel/callback-log.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  CALLBACK_LOG_TABLE, LOG_CAPS, logHubtelCallback, purgeOldCallbackLogs, shapeCallbackLogRow, withOutboundLogging, withStatusCheckLogging,
  __resetCallbackLogWarningsForTests,
} from "./callback-log"
import { dispatchCallback } from "./callbacks"

/** Fake client recording inserts and deletes; behaviour per call is configurable. */
function fakeClient(opts: {
  insertResult?: unknown; insertThrows?: boolean; insertRejects?: boolean; insertHangs?: boolean
  fromThrows?: boolean; deleteResult?: unknown; deleteHangs?: boolean
} = {}) {
  const inserts: Array<{ table: string; rows: any }> = []
  const deletes: Array<{ table: string; column: string; value: string }> = []
  const signals: AbortSignal[] = []
  /** Like a PostgREST builder: thenable with .abortSignal() returning itself. */
  const withAbort = (p: Promise<unknown>) => Object.assign(p, { abortSignal(s: AbortSignal) { signals.push(s); return p } })
  const client: any = {
    from(table: string) {
      if (opts.fromThrows) throw new Error("client exploded")
      return {
        insert(rows: any) {
          if (opts.insertThrows) throw new Error("insert threw")
          inserts.push({ table, rows })
          if (opts.insertHangs) return withAbort(new Promise(() => {}))
          if (opts.insertRejects) return withAbort(Promise.reject(new Error("insert rejected")))
          return withAbort(Promise.resolve(opts.insertResult ?? { error: null }))
        },
        delete() {
          return {
            lt(column: string, value: string) {
              deletes.push({ table, column, value })
              return withAbort(opts.deleteHangs ? new Promise(() => {}) : Promise.resolve(opts.deleteResult ?? { error: null }))
            },
          }
        },
      }
    },
  }
  return { client, inserts, deletes, signals }
}

const SECRETS = { HUBTEL_WEBHOOK_SECRET: "whsec-AAA111", HUBTEL_RELAY_SECRET: "relaysec-BBB222" }

beforeEach(() => {
  __resetCallbackLogWarningsForTests()
  for (const [k, v] of Object.entries(SECRETS)) vi.stubEnv(k, v)
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe("shapeCallbackLogRow", () => {
  it("maps an inbound entry to table columns", () => {
    const row = shapeCallbackLogRow({
      direction: "inbound_fulfillment", sessionId: "S1", hubtelOrderId: "H1", outcome: "fulfilled", ok: true,
      payload: { SessionId: "S1", OrderId: "H1" }, sourceIp: "52.50.116.54",
    })
    expect(row).toEqual({
      direction: "inbound_fulfillment", session_id: "S1", hubtel_order_id: "H1", outcome: "fulfilled", ok: true,
      http_status: null, payload: { SessionId: "S1", OrderId: "H1" }, raw_body: null, response: null, error: null,
      source_ip: "52.50.116.54",
    })
  })
  it("caps an oversized payload to a marker", () => {
    const big = { blob: "x".repeat(LOG_CAPS.payload + 10) }
    const row = shapeCallbackLogRow({ direction: "inbound_fulfillment", payload: big })
    expect(row.payload).toEqual({ truncated: true, size: JSON.stringify(big).length })
  })
  it("truncates raw_body to 20KB, response to 5KB and error to 500 chars", () => {
    const row = shapeCallbackLogRow({
      direction: "outbound_callback", rawBody: "r".repeat(30_000), response: "b".repeat(9_000), error: "e".repeat(900),
    })
    expect(LOG_CAPS).toMatchObject({ rawBody: 20_000, response: 5_000, error: 500 })
    expect(row.raw_body!.length).toBeLessThanOrEqual(20_000 + 20)
    expect(row.raw_body!.startsWith("r".repeat(100))).toBe(true)
    expect(row.response).toMatchObject({ truncated: true })
    expect(JSON.stringify(row.response).length).toBeLessThanOrEqual(5_000 + 100)
    expect(row.error!.length).toBeLessThanOrEqual(500 + 3)
  })
  it("keeps a small response as JSON", () => {
    const row = shapeCallbackLogRow({ direction: "outbound_callback", response: { upstreamStatus: 200, body: { ok: true } } })
    expect(row.response).toEqual({ upstreamStatus: 200, body: { ok: true } })
  })
  it("never stores secrets: env secret values and Bearer tokens are redacted everywhere", () => {
    const row = shapeCallbackLogRow({
      direction: "outbound_callback",
      payload: { note: `x ${SECRETS.HUBTEL_RELAY_SECRET}` },
      rawBody: `secret=${SECRETS.HUBTEL_WEBHOOK_SECRET}`,
      response: { echoed: `Authorization: Bearer ${SECRETS.HUBTEL_RELAY_SECRET}`, other: "Bearer abc.def" },
      error: `failed calling with ${SECRETS.HUBTEL_WEBHOOK_SECRET} Bearer zzz`,
    })
    const all = JSON.stringify(row)
    expect(all).not.toContain(SECRETS.HUBTEL_WEBHOOK_SECRET)
    expect(all).not.toContain(SECRETS.HUBTEL_RELAY_SECRET)
    expect(all).not.toContain("abc.def")
    expect(all).not.toContain("zzz")
    expect(all).toContain("[redacted]")
  })
  it("redacts Postgres row details from the error text", () => {
    const row = shapeCallbackLogRow({ direction: "outbound_callback", error: 'insert failed. Failing row contains (Kwame, GHA-1)' })
    expect(row.error).not.toContain("Kwame")
    expect(row.error).toContain("[row details redacted]")
  })
  it("tolerates an unserialisable payload", () => {
    const circ: any = { a: 1 }; circ.self = circ
    expect(() => shapeCallbackLogRow({ direction: "inbound_fulfillment", payload: circ })).not.toThrow()
    expect(shapeCallbackLogRow({ direction: "inbound_fulfillment", payload: circ }).payload).toMatchObject({ unserialisable: true })
  })
})

describe("logHubtelCallback (best-effort)", () => {
  it("inserts one shaped row into hubtel_callback_logs", async () => {
    const { client, inserts } = fakeClient()
    await logHubtelCallback(client, { direction: "inbound_fulfillment", sessionId: "S1", outcome: "duplicate", ok: true })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe(CALLBACK_LOG_TABLE)
    expect(inserts[0].rows).toMatchObject({ direction: "inbound_fulfillment", session_id: "S1", outcome: "duplicate" })
  })
  it("never throws: insert returns an error, insert throws, client.from throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const opts of [{ insertResult: { error: { code: "XX000", message: "boom" } } }, { insertThrows: true }, { fromThrows: true }]) {
      const { client } = fakeClient(opts)
      await expect(logHubtelCallback(client, { direction: "outbound_callback" })).resolves.toBeUndefined()
    }
  })
  it("table missing (42P01 / PGRST205): silent, warns only once per process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const a = fakeClient({ insertResult: { error: { code: "42P01", message: 'relation "hubtel_callback_logs" does not exist' } } })
    const b = fakeClient({ insertResult: { error: { code: "PGRST205", message: "Could not find the table" } } })
    await logHubtelCallback(a.client, { direction: "outbound_callback" })
    await logHubtelCallback(b.client, { direction: "outbound_callback" })
    await logHubtelCallback(a.client, { direction: "outbound_callback" })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(err).not.toHaveBeenCalled()
  })
  it("a null / undefined client is a no-op", async () => {
    await expect(logHubtelCallback(null as never, { direction: "outbound_callback" })).resolves.toBeUndefined()
  })
})

describe("withOutboundLogging", () => {
  it("logs a successful attempt and returns the original result unchanged", async () => {
    const { client, inserts } = fakeClient()
    const result = { ok: true, upstreamStatus: 200, upstreamBody: { ResponseCode: "0000" } }
    const send = vi.fn(async () => result)
    const wrapped = withOutboundLogging(send, client)
    const r = await wrapped({ sessionId: "S1", orderId: "H1" })
    expect(r).toBe(result)
    expect(send).toHaveBeenCalledWith({ sessionId: "S1", orderId: "H1" })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].rows).toMatchObject({
      direction: "outbound_callback", session_id: "S1", hubtel_order_id: "H1", outcome: "sent", ok: true, http_status: 200,
      payload: { SessionId: "S1", OrderId: "H1", ServiceStatus: "success", MetaData: null },
      response: { ResponseCode: "0000" }, error: null,
    })
  })
  it("logs a failed attempt with status, body and error", async () => {
    const { client, inserts } = fakeClient()
    const result = { ok: false, error: "relay/hubtel 400: {\"x\":1}", upstreamStatus: 400, upstreamBody: { x: 1 } }
    const r = await withOutboundLogging(async () => result, client)({ sessionId: "S2", orderId: "H2" })
    expect(r).toBe(result)
    expect(inserts[0].rows).toMatchObject({ outcome: "failed", ok: false, http_status: 400, response: { x: 1 }, error: "relay/hubtel 400: {\"x\":1}" })
  })
  it("a failing logger never changes the result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeClient({ insertThrows: true })
    const result = { ok: true }
    await expect(withOutboundLogging(async () => result, client)({ sessionId: "S", orderId: "O" })).resolves.toBe(result)
  })
  it("a throwing sender is logged as failed and the error is rethrown", async () => {
    const { client, inserts } = fakeClient()
    const boom = new Error("socket hang up")
    await expect(withOutboundLogging(async () => { throw boom }, client)({ sessionId: "S", orderId: "O" })).rejects.toBe(boom)
    expect(inserts[0].rows).toMatchObject({ outcome: "failed", ok: false, error: "socket hang up" })
  })
})

describe("withStatusCheckLogging", () => {
  it("logs the full Hubtel response and returns the original result unchanged", async () => {
    const { client, inserts } = fakeClient()
    const body = { responseCode: "0000", data: { status: "Paid", transactionId: "T-9", clientReference: "S1" } }
    const result = { ok: true, status: "Paid", data: body.data, upstreamStatus: 200, body }
    const check = vi.fn(async () => result)
    const wrapped = withStatusCheckLogging(check, client)
    const r = await wrapped("S1")
    await wrapped.flush()
    expect(r).toBe(result)
    expect(check).toHaveBeenCalledWith("S1")
    expect(inserts).toHaveLength(1)
    expect(inserts[0].rows).toMatchObject({
      direction: "status_check", session_id: "S1", hubtel_order_id: "T-9", outcome: "Paid", ok: true, http_status: 200,
      payload: { clientReference: "S1" }, response: body, error: null,
    })
  })
  it("records an Unpaid answer as a normal (non-problem) entry", async () => {
    const { client, inserts } = fakeClient()
    const result = { ok: true, status: "Unpaid", data: { status: "Unpaid" }, upstreamStatus: 200, body: { data: { status: "Unpaid" } } }
    await withStatusCheckLogging(async () => result, client)("S2")
    expect(inserts[0].rows).toMatchObject({ outcome: "Unpaid", ok: true, hubtel_order_id: null })
  })
  it("a failed lookup is logged as an error with the status, body and error text", async () => {
    const { client, inserts } = fakeClient()
    const result = { ok: false, error: "relay/hubtel 404", upstreamStatus: 404, body: { message: "not found" } }
    const r = await withStatusCheckLogging(async () => result, client)("S3")
    expect(r).toBe(result)
    expect(inserts[0].rows).toMatchObject({ outcome: "error", ok: false, http_status: 404, response: { message: "not found" }, error: "relay/hubtel 404" })
  })
  it("a throwing checker is logged and the error is rethrown", async () => {
    const { client, inserts } = fakeClient()
    const boom = new Error("socket hang up")
    await expect(withStatusCheckLogging(async () => { throw boom }, client)("S4")).rejects.toBe(boom)
    expect(inserts[0].rows).toMatchObject({ direction: "status_check", outcome: "error", ok: false, error: "socket hang up" })
  })
  it("a failing logger never changes the result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeClient({ insertThrows: true })
    const result = { ok: true, status: "Paid" }
    await expect(withStatusCheckLogging(async () => result, client)("S5")).resolves.toBe(result)
  })
})

describe("withOutboundLogging: logging stays out of the send-to-sent gap", () => {
  afterEach(() => { vi.useRealTimers() })

  it("a log insert that NEVER resolves does not delay send(): dispatchCallback marks 'sent' immediately", async () => {
    const { client } = fakeClient({ insertHangs: true })
    const updates: Array<Record<string, unknown>> = []
    const store: any = {
      findBySession: async () => ({ session_id: "S1", hubtel_order_id: "H1", callback_status: "pending", callback_attempts: 0, paid_at: new Date().toISOString() }),
      update: async (_sid: string, patch: Record<string, unknown>) => { updates.push(patch) },
    }
    const send = withOutboundLogging(async () => ({ ok: true, upstreamStatus: 200 }), client)
    // Would time out (5s test timeout) if the wrapper awaited the hanging insert.
    await expect(dispatchCallback(store, send, "S1")).resolves.toBe("sent")
    expect(updates).toEqual([expect.objectContaining({ callback_status: "sent" })])
  })
  it("flush() resolves within the 3s bound even if the insert hangs", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeClient({ insertHangs: true })
    const send = withOutboundLogging(async () => ({ ok: true }), client)
    await send({ sessionId: "S1", orderId: "H1" })
    let done = false
    const f = send.flush().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(2_900)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    await f
    expect(done).toBe(true)
  })
  it("returns the identical result object and rethrows the identical error object; logs are scheduled", async () => {
    const { client, inserts } = fakeClient()
    const result = { ok: true }
    const ok = withOutboundLogging(async () => result, client)
    expect(await ok({ sessionId: "A", orderId: "B" })).toBe(result)
    const boom = new Error("x")
    const bad = withOutboundLogging(async () => { throw boom }, client)
    await expect(bad({ sessionId: "A", orderId: "B" })).rejects.toBe(boom)
    await ok.flush(); await bad.flush()
    expect(inserts).toHaveLength(2)
  })
  it("flush after a failed (thrown / errored) insert never throws, and can be called repeatedly", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    for (const opts of [{ insertThrows: true }, { insertResult: { error: { message: "x" } } }, { insertRejects: true }]) {
      const send = withOutboundLogging(async () => ({ ok: false, error: "e" }), fakeClient(opts).client)
      await send({ sessionId: "S", orderId: "O" })
      await expect(send.flush()).resolves.toBeUndefined()
      await expect(send.flush()).resolves.toBeUndefined()
    }
  })
  it("every log insert is given a 3s abort signal", async () => {
    const { client, signals } = fakeClient()
    await logHubtelCallback(client, { direction: "outbound_callback" })
    expect(signals).toHaveLength(1)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })
  it("logHubtelCallback itself resolves after 3s when the insert hangs (one PII-free warning)", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { client } = fakeClient({ insertHangs: true })
    const p = logHubtelCallback(client, { direction: "inbound_fulfillment", sessionId: "S-secret-ish", payload: { CustomerName: "Kwame" } })
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(p).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Kwame")
  })
})

describe("purgeOldCallbackLogs", () => {
  it("deletes rows older than N days (default 30)", async () => {
    const { client, deletes } = fakeClient()
    const now = Date.parse("2026-10-07T12:00:00.000Z")
    await purgeOldCallbackLogs(client, 30, now)
    await purgeOldCallbackLogs(client, undefined, now)
    expect(deletes).toEqual([
      { table: CALLBACK_LOG_TABLE, column: "created_at", value: "2026-09-07T12:00:00.000Z" },
      { table: CALLBACK_LOG_TABLE, column: "created_at", value: "2026-09-07T12:00:00.000Z" },
    ])
  })
  it("never deletes for a non-positive or non-finite retention", async () => {
    const { client, deletes } = fakeClient()
    for (const days of [0, -5, NaN, Infinity, 0.5]) await purgeOldCallbackLogs(client, days)
    expect(deletes).toEqual([])
  })
  it("the purge is bounded too (hanging delete resolves after 3s)", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { client, signals } = fakeClient({ deleteHangs: true })
    const p = purgeOldCallbackLogs(client)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(p).resolves.toBeUndefined()
    expect(signals).toHaveLength(1)
    vi.useRealTimers()
  })
  it("swallows errors (returned, thrown, table missing)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const opts of [{ deleteResult: { error: { message: "x" } } }, { fromThrows: true }, { deleteResult: { error: { code: "42P01", message: "missing" } } }]) {
      await expect(purgeOldCallbackLogs(fakeClient(opts).client)).resolves.toBeUndefined()
    }
  })
})
