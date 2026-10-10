// lib/ussd-hubtel/relay.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { buildCallbackPayload, sendFulfillmentCallback, fetchDisbursementBalance } from "./relay"

const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubEnv("HUBTEL_RELAY_URL", "https://relay.example/")
  vi.stubEnv("HUBTEL_RELAY_SECRET", "relaysec")
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json })

describe("sendFulfillmentCallback: additive upstream fields", () => {
  it("success: ok + upstreamStatus + upstreamBody; sends the same payload as buildCallbackPayload", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, upstreamStatus: 200, body: { ResponseCode: "0000" } }))
    const r = await sendFulfillmentCallback({ sessionId: "S1", orderId: "H1" })
    expect(r).toEqual({ ok: true, upstreamStatus: 200, upstreamBody: { ResponseCode: "0000" } })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://relay.example/callback")
    expect(JSON.parse(init.body)).toEqual(buildCallbackPayload({ sessionId: "S1", orderId: "H1" }))
    expect(buildCallbackPayload({ sessionId: "S1", orderId: "H1" })).toEqual({ SessionId: "S1", OrderId: "H1", ServiceStatus: "success", MetaData: null })
    expect(buildCallbackPayload({ sessionId: "S1", orderId: "H1", serviceStatus: "failed" }).ServiceStatus).toBe("failed")
  })
  it("Hubtel rejected: ok false, same error text as before, plus status and body", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: false, upstreamStatus: 400, body: { message: "bad" } }))
    const r = await sendFulfillmentCallback({ sessionId: "S1", orderId: "H1" })
    expect(r).toEqual({ ok: false, error: 'relay/hubtel 400: {"message":"bad"}', upstreamStatus: 400, upstreamBody: { message: "bad" } })
  })
  it("relay itself rejected (401): status from the relay response", async () => {
    fetchMock.mockResolvedValue(reply(401, { error: "unauthorized" }))
    const r = await sendFulfillmentCallback({ sessionId: "S1", orderId: "H1" })
    expect(r.ok).toBe(false)
    expect(r.upstreamStatus).toBe(401)
    expect(r.error).toBe("relay/hubtel 401: null")
  })
  it("network error: ok false with the error, no status", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"))
    expect(await sendFulfillmentCallback({ sessionId: "S1", orderId: "H1" })).toEqual({ ok: false, error: "fetch failed" })
  })
  it("relay not configured: unchanged", async () => {
    vi.stubEnv("HUBTEL_RELAY_URL", "")
    expect(await sendFulfillmentCallback({ sessionId: "S1", orderId: "H1" })).toEqual({ ok: false, error: "relay not configured" })
  })
})

describe("fetchDisbursementBalance", () => {
  it("returns the amount on responseCode 0000", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, upstreamStatus: 200, body: { responseCode: "0000", data: { amount: 123.5 } } }))
    expect(await fetchDisbursementBalance()).toEqual({ ok: true, amountGhs: 123.5 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://relay.example/balance")
    expect(init.headers.Authorization).toBe("Bearer relaysec")
  })
  it("fails on any other response code", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, upstreamStatus: 200, body: { responseCode: "4000" } }))
    expect((await fetchDisbursementBalance()).ok).toBe(false)
  })
  it("fails when the amount is missing or not a number", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, upstreamStatus: 200, body: { responseCode: "0000", data: { amount: "11.5" } } }))
    expect((await fetchDisbursementBalance()).ok).toBe(false)
  })
  it("fails when the relay reports an upstream failure", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: false, upstreamStatus: 403, body: "forbidden" }))
    expect((await fetchDisbursementBalance()).ok).toBe(false)
  })
  it("fails on a network error (never throws)", async () => {
    fetchMock.mockRejectedValue(new Error("boom"))
    expect(await fetchDisbursementBalance()).toEqual({ ok: false, error: "boom" })
  })
  it("fails when the relay is not configured", async () => {
    vi.stubEnv("HUBTEL_RELAY_URL", "")
    expect((await fetchDisbursementBalance()).ok).toBe(false)
  })
})
