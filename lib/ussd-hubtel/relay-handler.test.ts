// lib/ussd-hubtel/relay-handler.test.ts
import { describe, it, expect, vi } from "vitest"
import { createRelayHandler } from "./relay-handler"

function setup(upstream: { status: number; json: unknown } = { status: 200, json: { ok: 1 } }) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(upstream.json), { status: upstream.status }))
  const handler = createRelayHandler({
    secret: "s3cret", collectionAccount: "11684", statusBasicAuth: "BASICXYZ", fetchImpl: fetchImpl as any,
  })
  return { handler, fetchImpl }
}
const auth = "Bearer s3cret"

describe("relay handler", () => {
  it("rejects missing or wrong bearer", async () => {
    const { handler } = setup()
    expect((await handler({ method: "POST", path: "/callback", query: new URLSearchParams(), authorization: null, body: "{}" })).status).toBe(401)
    expect((await handler({ method: "POST", path: "/callback", query: new URLSearchParams(), authorization: "Bearer nope", body: "{}" })).status).toBe(401)
  })

  it("forwards only the four callback fields to the Hubtel callback URL", async () => {
    const { handler, fetchImpl } = setup()
    const res = await handler({
      method: "POST", path: "/callback", query: new URLSearchParams(), authorization: auth,
      body: JSON.stringify({ SessionId: "S1", OrderId: "O1", ServiceStatus: "success", MetaData: null, evil: "x" }),
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, upstreamStatus: 200 })
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toBe("https://gs-callback.hubtel.com:9055/callback")
    expect(JSON.parse(init.body)).toEqual({ SessionId: "S1", OrderId: "O1", ServiceStatus: "success", MetaData: null })
  })

  it("rejects a callback missing SessionId or OrderId", async () => {
    const { handler } = setup()
    const res = await handler({ method: "POST", path: "/callback", query: new URLSearchParams(), authorization: auth, body: JSON.stringify({ SessionId: "S1" }) })
    expect(res.status).toBe(400)
  })

  it("status check builds the Hubtel URL with Basic auth and a validated reference", async () => {
    const { handler, fetchImpl } = setup({ status: 200, json: { data: { status: "Paid" } } })
    const res = await handler({ method: "GET", path: "/status", query: new URLSearchParams({ clientReference: "abc123" }), authorization: auth, body: "" })
    expect(res.body).toMatchObject({ ok: true, body: { data: { status: "Paid" } } })
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toBe("https://api-txnstatus.hubtel.com/transactions/11684/status?clientReference=abc123")
    expect(init.headers.Authorization).toBe("Basic BASICXYZ")
  })

  it("status check rejects unsafe references", async () => {
    const { handler } = setup()
    const res = await handler({ method: "GET", path: "/status", query: new URLSearchParams({ clientReference: "a/../b" }), authorization: auth, body: "" })
    expect(res.status).toBe(400)
  })

  it("reports upstream failure as ok:false without throwing", async () => {
    const { handler } = setup({ status: 500, json: { err: 1 } })
    const res = await handler({
      method: "POST", path: "/callback", query: new URLSearchParams(), authorization: auth,
      body: JSON.stringify({ SessionId: "S1", OrderId: "O1", ServiceStatus: "success", MetaData: null }),
    })
    expect(res.body).toMatchObject({ ok: false, upstreamStatus: 500 })
  })

  it("gives both upstream calls an AbortSignal (bounded upstream time)", async () => {
    const { handler, fetchImpl } = setup()
    await handler({
      method: "POST", path: "/callback", query: new URLSearchParams(), authorization: auth,
      body: JSON.stringify({ SessionId: "S1", OrderId: "O1" }),
    })
    await handler({ method: "GET", path: "/status", query: new URLSearchParams({ clientReference: "abc" }), authorization: auth, body: "" })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const call of fetchImpl.mock.calls as any[]) expect(call[1].signal).toBeInstanceOf(AbortSignal)
  })

  it("an upstream timeout/abort yields ok:false, upstreamStatus 0 (both paths)", async () => {
    const fetchImpl = vi.fn(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError") })
    const handler = createRelayHandler({ secret: "s3cret", collectionAccount: "11684", statusBasicAuth: "B", fetchImpl: fetchImpl as any })
    const cb = await handler({
      method: "POST", path: "/callback", query: new URLSearchParams(), authorization: auth,
      body: JSON.stringify({ SessionId: "S1", OrderId: "O1" }),
    })
    const st = await handler({ method: "GET", path: "/status", query: new URLSearchParams({ clientReference: "abc" }), authorization: auth, body: "" })
    for (const r of [cb, st]) {
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ ok: false, upstreamStatus: 0 })
    }
  })

  it("balance: forwards to the prepaid endpoint with Basic auth", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ responseCode: "0000", data: { amount: 11.5 } }), { status: 200 }))
    const handler = createRelayHandler({ secret: "s3cret", collectionAccount: "11684", statusBasicAuth: "BASICXYZ", disbursementAccount: "11691", fetchImpl: fetchImpl as any })
    const res = await handler({ method: "GET", path: "/balance", query: new URLSearchParams(), authorization: auth, body: "" })
    expect(res).toMatchObject({ status: 200, body: { ok: true, upstreamStatus: 200, body: { responseCode: "0000", data: { amount: 11.5 } } } })
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toBe("https://trnf.hubtel.com/api/inter-transfers/prepaid/11691")
    expect(init.headers.Authorization).toBe("Basic BASICXYZ")
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("balance: prefers a dedicated balance credential", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }))
    const handler = createRelayHandler({ secret: "s3cret", collectionAccount: "1", statusBasicAuth: "STATUS", balanceBasicAuth: "BAL", disbursementAccount: "2", fetchImpl: fetchImpl as any })
    await handler({ method: "GET", path: "/balance", query: new URLSearchParams(), authorization: auth, body: "" })
    expect((fetchImpl.mock.calls[0] as any)[1].headers.Authorization).toBe("Basic BAL")
  })

  it("balance: 501 when no disbursement account is configured", async () => {
    const { handler } = setup()
    expect((await handler({ method: "GET", path: "/balance", query: new URLSearchParams(), authorization: auth, body: "" })).status).toBe(501)
  })

  it("balance: requires the bearer and reports upstream timeouts as ok:false", async () => {
    const fetchImpl = vi.fn(async () => { throw new DOMException("timeout", "TimeoutError") })
    const handler = createRelayHandler({ secret: "s3cret", collectionAccount: "1", statusBasicAuth: "S", disbursementAccount: "2", fetchImpl: fetchImpl as any })
    expect((await handler({ method: "GET", path: "/balance", query: new URLSearchParams(), authorization: null, body: "" })).status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
    const res = await handler({ method: "GET", path: "/balance", query: new URLSearchParams(), authorization: auth, body: "" })
    expect(res.body).toMatchObject({ ok: false, upstreamStatus: 0 })
  })

  it("404s unknown paths", async () => {
    const { handler } = setup()
    expect((await handler({ method: "GET", path: "/nope", query: new URLSearchParams(), authorization: auth, body: "" })).status).toBe(404)
  })
})
