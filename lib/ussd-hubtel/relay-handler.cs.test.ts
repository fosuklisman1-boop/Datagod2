import { describe, expect, it, vi } from "vitest"
import { createRelayHandler } from "./relay-handler"

const SID = "fdd76c884e614b1c8f669a3207b09a98"
const mk = (over: any = {}, fetchImpl?: any) =>
  createRelayHandler({
    secret: "rs", collectionAccount: "11684", statusBasicAuth: "STATUS",
    disbursementAccount: "11691", csBasicAuth: "CSAUTH",
    fetchImpl: fetchImpl ?? vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "0001" }), { status: 200 })),
    ...over,
  })
const req = (over: any = {}) => ({ method: "POST", path: `/cs/${SID}`, query: new URLSearchParams(), authorization: "Bearer rs", body: JSON.stringify({ Amount: 1 }), ...over })

describe("relay /cs passthrough", () => {
  it("401 without the bearer secret", async () => {
    expect((await mk()(req({ authorization: null }))).status).toBe(401)
  })
  it("501 when the CS credential or disbursement account is not configured", async () => {
    expect((await mk({ csBasicAuth: undefined })(req())).status).toBe(501)
    expect((await mk({ disbursementAccount: undefined })(req())).status).toBe(501)
  })
  it("POST forwards the body to cs.hubtel.com with the CS credential", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "0001" }), { status: 200 }))
    const out = await mk({}, f)(req())
    expect(out).toEqual({ status: 200, body: { ok: true, upstreamStatus: 200, body: { ResponseCode: "0001" } } })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe(`https://cs.hubtel.com/commissionservices/11691/${SID}`)
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Basic CSAUTH")
    expect(JSON.parse(init.body)).toEqual({ Amount: 1 })
  })
  it("GET forwards only destination and mobile", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "0000" }), { status: 200 }))
    await mk({}, f)(req({ method: "GET", body: "", query: new URLSearchParams("destination=233246912184&mobile=233242825109&evil=1&x=y") }))
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe(`https://cs.hubtel.com/commissionservices/11691/${SID}?destination=233246912184&mobile=233242825109`)
    expect(init.body).toBeUndefined()
  })
  it("rejects a service id that is not 32 hex chars (no open proxy)", async () => {
    expect((await mk()(req({ path: "/cs/../../etc" }))).status).toBe(404)
    expect((await mk()(req({ path: "/cs/ABC" }))).status).toBe(404)
    expect((await mk()(req({ path: `/cs/${SID}/extra` }))).status).toBe(404)
  })
  it("POST with a non-object / invalid json body -> 400", async () => {
    expect((await mk()(req({ body: "{nope" }))).status).toBe(400)
    expect((await mk()(req({ body: "[1,2]" }))).status).toBe(400)
  })
  it("an upstream network error is reported as upstreamStatus 0 (never throws)", async () => {
    const out = await mk({}, async () => { throw new Error("ECONNRESET") })(req())
    expect(out).toEqual({ status: 200, body: { ok: false, upstreamStatus: 0, body: "ECONNRESET" } })
  })
  it("only GET and POST are allowed", async () => {
    expect((await mk()(req({ method: "DELETE" }))).status).toBe(404)
  })
})
