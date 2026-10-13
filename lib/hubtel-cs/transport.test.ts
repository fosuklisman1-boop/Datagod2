import { describe, it, expect, vi } from "vitest"
import { createDirectTransport, createRelayTransport, transportFromEnv } from "./transport"
import { HubtelNotConfiguredError } from "./errors"

const jsonRes = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })

describe("direct transport", () => {
  const mk = (fetchImpl: any) => createDirectTransport({ disbursementAccount: "11691", basicAuth: "QUJD", fetchImpl })

  it("POSTs json to {base}/{account}/{serviceId} with Basic auth", async () => {
    const f = vi.fn(async () => jsonRes(200, { ResponseCode: "0001" }))
    const out = await mk(f).call({ method: "POST", serviceId: "fdd76c884e614b1c8f669a3207b09a98", body: { Amount: 1 } })
    expect(out).toEqual({ httpStatus: 200, body: { ResponseCode: "0001" } })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://cs.hubtel.com/commissionservices/11691/fdd76c884e614b1c8f669a3207b09a98")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Basic QUJD")
    expect(JSON.parse(init.body)).toEqual({ Amount: 1 })
  })
  it("GET puts query params in the url and sends no body", async () => {
    const f = vi.fn(async () => jsonRes(200, { ResponseCode: "0000" }))
    await mk(f).call({ method: "GET", serviceId: "b230733cd56b4a0fad820e39f66bc27c", query: { destination: "233246912184" } })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://cs.hubtel.com/commissionservices/11691/b230733cd56b4a0fad820e39f66bc27c?destination=233246912184")
    expect(init.body).toBeUndefined()
  })
  it("a network error or timeout becomes { error }", async () => {
    const out = await mk(async () => { throw new Error("fetch failed") }).call({ method: "POST", serviceId: "x".repeat(32), body: {} })
    expect(out).toEqual({ error: "fetch failed" })
  })
  it("non-json bodies come back as text (e.g. an html 502 page)", async () => {
    const out = await mk(async () => jsonRes(502, "<html>Bad gateway</html>")).call({ method: "POST", serviceId: "x".repeat(32), body: {} })
    expect(out).toEqual({ httpStatus: 502, body: "<html>Bad gateway</html>" })
  })
})

describe("relay transport", () => {
  const mk = (fetchImpl: any) => createRelayTransport({ relayUrl: "https://relay.example.com/", relaySecret: "rs", fetchImpl })

  it("POSTs to {relay}/cs/{serviceId} with the bearer secret and unwraps the envelope", async () => {
    const f = vi.fn(async () => jsonRes(200, { ok: true, upstreamStatus: 200, body: { ResponseCode: "0001" } }))
    const out = await mk(f).call({ method: "POST", serviceId: "fdd76c884e614b1c8f669a3207b09a98", body: { Amount: 1 } })
    expect(out).toEqual({ httpStatus: 200, body: { ResponseCode: "0001" } })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://relay.example.com/cs/fdd76c884e614b1c8f669a3207b09a98")
    expect(init.headers.Authorization).toBe("Bearer rs")
  })
  it("upstreamStatus 0 (relay could not reach Hubtel) -> { error }", async () => {
    const out = await mk(async () => jsonRes(200, { ok: false, upstreamStatus: 0, body: "ECONNRESET" })).call({ method: "POST", serviceId: "x".repeat(32), body: {} })
    expect(out).toEqual({ error: "ECONNRESET" })
  })
  it("a relay refusal (401/501) -> { error }", async () => {
    const out = await mk(async () => jsonRes(501, { error: "cs not configured" })).call({ method: "GET", serviceId: "x".repeat(32), query: { destination: "1" } })
    expect("error" in out && out.error).toMatch(/relay 501/)
  })
})

describe("transportFromEnv", () => {
  it("throws HubtelNotConfiguredError listing what is missing", () => {
    expect(() => transportFromEnv("direct", {})).toThrow(HubtelNotConfiguredError)
    try { transportFromEnv("direct", { HUBTEL_CS_BASIC_AUTH: "a" }) } catch (e: any) { expect(e.missing).toEqual(["HUBTEL_DISBURSEMENT_ACCOUNT"]) }
    try { transportFromEnv("relay", {}) } catch (e: any) { expect(e.missing).toEqual(["HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET"]) }
  })
  it("builds a transport when configured", () => {
    expect(transportFromEnv("direct", { HUBTEL_CS_BASIC_AUTH: "a", HUBTEL_DISBURSEMENT_ACCOUNT: "1" }).call).toBeTypeOf("function")
    expect(transportFromEnv("relay", { HUBTEL_RELAY_URL: "https://r", HUBTEL_RELAY_SECRET: "s" }).call).toBeTypeOf("function")
  })
})
