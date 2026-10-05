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

  it("404s unknown paths", async () => {
    const { handler } = setup()
    expect((await handler({ method: "GET", path: "/nope", query: new URLSearchParams(), authorization: auth, body: "" })).status).toBe(404)
  })
})
