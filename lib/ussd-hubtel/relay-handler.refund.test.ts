import { describe, expect, it, vi } from "vitest"
import { createRelayHandler } from "./relay-handler"

const OID = "fdd76c884e614b1c8f669a3207b09a98"
const CB = "https://example.com/api/hubtel/refund-callback"
const mk = (over: any = {}, fetchImpl?: any) =>
  createRelayHandler({
    secret: "rs", collectionAccount: "11684", statusBasicAuth: "STATUS",
    fetchImpl: fetchImpl ?? vi.fn(async () => new Response(JSON.stringify({ responseCode: "0001" }), { status: 202 })),
    ...over,
  })
const req = (over: any = {}) => ({ method: "POST", path: "/refund", query: new URLSearchParams(), authorization: "Bearer rs", body: JSON.stringify({ orderId: OID, callbackUrl: CB }), ...over })

describe("relay /refund passthrough", () => {
  it("401 without the bearer secret", async () => {
    expect((await mk()(req({ authorization: null }))).status).toBe(401)
  })
  it("400 when orderId is not 32 hex chars", async () => {
    expect((await mk()(req({ body: JSON.stringify({ orderId: "../x", callbackUrl: CB }) }))).status).toBe(400)
    expect((await mk()(req({ body: JSON.stringify({ callbackUrl: CB }) }))).status).toBe(400)
  })
  it("400 when callbackUrl is not https", async () => {
    expect((await mk()(req({ body: JSON.stringify({ orderId: OID, callbackUrl: "http://example.com/cb" }) }))).status).toBe(400)
    expect((await mk()(req({ body: JSON.stringify({ orderId: OID, callbackUrl: "not a url" }) }))).status).toBe(400)
  })
  it("400 on invalid json", async () => {
    expect((await mk()(req({ body: "{nope" }))).status).toBe(400)
  })
  it("forwards to the refund API with the status credential", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ responseCode: "0001" }), { status: 202 }))
    await mk({}, f)(req())
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe(`https://refund-api.hubtel.com/refund/11684/order/${OID}`)
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Basic STATUS")
    expect(JSON.parse(init.body)).toEqual({ callbackUrl: CB })
  })
  it("uses refundBasicAuth when set", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 202 }))
    await mk({ refundBasicAuth: "REFUNDAUTH" }, f)(req())
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe("Basic REFUNDAUTH")
  })
  it("maps a 202 into ok:true", async () => {
    const out = await mk()(req())
    expect(out).toEqual({ status: 200, body: { ok: true, upstreamStatus: 202, body: { responseCode: "0001" } } })
  })
  it("passes a 423 through as ok:false", async () => {
    const out = await mk({}, async () => new Response(JSON.stringify({ responseCode: "x" }), { status: 423 }))(req())
    expect(out).toEqual({ status: 200, body: { ok: false, upstreamStatus: 423, body: { responseCode: "x" } } })
  })
  it("a network error is reported as upstreamStatus 0", async () => {
    const out = await mk({}, async () => { throw new Error("ECONNRESET") })(req())
    expect(out).toEqual({ status: 200, body: { ok: false, upstreamStatus: 0, body: "ECONNRESET" } })
  })
})
