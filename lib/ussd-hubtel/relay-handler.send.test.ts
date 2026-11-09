// lib/ussd-hubtel/relay-handler.send.test.ts
// Relay routes /send (Direct Send Money, used for refunds) and /send-status (its status check).
import { describe, expect, it, vi } from "vitest"
import { createRelayHandler } from "./relay-handler"

const REF = "0123456789abcdef0123456789abcdef"
const CB = `https://www.datagod.store/api/webhooks/hubtel-send?ref=${REF}&sig=abc`

const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "0001" }), { status: 200 }))
const mk = (over: any = {}, fetchImpl?: any) =>
  createRelayHandler({
    secret: "rs", collectionAccount: "11684", statusBasicAuth: "STATUS", appHost: "www.datagod.store",
    disbursementAccount: "2025100", fetchImpl: fetchImpl ?? okFetch(), ...over,
  })

const sendBody = (over: any = {}) => ({ reference: REF, msisdn: "233241234567", channel: "mtn-gh", amount: 12.5, callbackUrl: CB, ...over })
const req = (path: string, body: unknown, over: any = {}) => ({
  method: "POST", path, query: new URLSearchParams(), authorization: "Bearer rs",
  body: typeof body === "string" ? body : JSON.stringify(body), ...over,
})
const getReq = (path: string, query: string, over: any = {}) => ({
  method: "GET", path, query: new URLSearchParams(query), authorization: "Bearer rs", body: "", ...over,
})

function connErr(code: string) {
  const e: any = new TypeError("fetch failed")
  e.cause = Object.assign(new Error(`connect ${code}`), { code })
  return e
}

describe("relay /send", () => {
  it("401 without the bearer secret, nothing sent", async () => {
    const f = okFetch()
    expect((await mk({}, f)(req("/send", sendBody(), { authorization: null }))).status).toBe(401)
    expect((await mk({}, f)(req("/send", sendBody(), { authorization: "Bearer nope" }))).status).toBe(401)
    expect(f).not.toHaveBeenCalled()
  })

  it("501 without a disbursement account or app host, nothing sent", async () => {
    for (const over of [{ disbursementAccount: undefined }, { appHost: undefined }]) {
      const f = okFetch()
      const out = await mk(over, f)(req("/send", sendBody()))
      expect(out.status).toBe(501)
      expect(f).not.toHaveBeenCalled()
    }
  })

  it("forwards the exact URL, headers and body to Hubtel; Description is fixed to Refund", async () => {
    const f = okFetch()
    const out = await mk({}, f)(req("/send", sendBody({ extra: "dropped", description: "Sneaky product name" })))
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://smp.hubtel.com/api/merchants/2025100/send/mobilemoney")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      Authorization: "Basic STATUS", Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-cache",
    })
    expect(init.redirect).toBe("error")
    expect(JSON.parse(init.body)).toEqual({
      RecipientName: "233241234567", RecipientMsisdn: "233241234567", Channel: "mtn-gh", Amount: 12.5,
      PrimaryCallbackURL: CB, Description: "Clingshub", ClientReference: REF,
    })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, upstreamStatus: 200, body: { ResponseCode: "0001" }, sent: true })
  })

  it("uses sendBasicAuth when set, else the status credential", async () => {
    const f = okFetch()
    await mk({ sendBasicAuth: "SEND" }, f)(req("/send", sendBody()))
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe("Basic SEND")
  })

  it.each([
    ["non-JSON body", "not json"],
    ["a JSON array", []],
    ["bad reference (uppercase)", sendBody({ reference: REF.toUpperCase() })],
    ["short reference", sendBody({ reference: "abc" })],
    ["msisdn without 233", sendBody({ msisdn: "0241234567" })],
    ["msisdn with plus", sendBody({ msisdn: "+233241234567" })],
    ["unknown channel", sendBody({ channel: "airtel-gh" })],
    ["amount below 0.10", sendBody({ amount: 0.05 })],
    ["amount above 10000", sendBody({ amount: 10000.5 })],
    ["amount with 3 decimals", sendBody({ amount: 1.005 })],
    ["amount as a string", sendBody({ amount: "12.5" })],
    ["amount NaN-like", sendBody({ amount: null })],
    ["callback on another host", sendBody({ callbackUrl: `https://evil.example/api/webhooks/hubtel-send?ref=${REF}&sig=abc` })],
    ["callback over http", sendBody({ callbackUrl: `http://www.datagod.store/api/webhooks/hubtel-send?ref=${REF}&sig=abc` })],
    ["callback with credentials", sendBody({ callbackUrl: `https://u:p@www.datagod.store/api/webhooks/hubtel-send?ref=${REF}&sig=abc` })],
    ["callback on another path", sendBody({ callbackUrl: `https://www.datagod.store/api/webhooks/other?ref=${REF}&sig=abc` })],
    ["callback missing", sendBody({ callbackUrl: undefined })],
    ["callback too long", sendBody({ callbackUrl: `${CB}&x=${"a".repeat(600)}` })],
  ])("400 for %s, fetch never called", async (_name, body) => {
    const f = okFetch()
    const out = await mk({}, f)(req("/send", body as any))
    expect(out.status).toBe(400)
    expect(f).not.toHaveBeenCalled()
  })

  it("a throw before sending (connection refused) reports sent:false", async () => {
    const f = vi.fn(async () => { throw connErr("ECONNREFUSED") })
    const out = await mk({}, f)(req("/send", sendBody()))
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: false, upstreamStatus: 0, sent: false })
  })

  it("a timeout after sending reports sent:true", async () => {
    const f = vi.fn(async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }) })
    const out = await mk({}, f)(req("/send", sendBody()))
    expect(out.body).toMatchObject({ ok: false, upstreamStatus: 0, sent: true })
  })

  it("an unrecognised throw counts as sent", async () => {
    const f = vi.fn(async () => { throw new Error("weird") })
    expect((await mk({}, f)(req("/send", sendBody()))).body).toMatchObject({ sent: true })
  })

  it("relays Hubtel's HTTP error with its body, sent:true", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "4075" }), { status: 400 }))
    const out = await mk({}, f)(req("/send", sendBody()))
    expect(out.body).toEqual({ ok: false, upstreamStatus: 400, body: { ResponseCode: "4075" }, sent: true })
  })
})

describe("relay /send-status", () => {
  it("401 without the secret, nothing sent", async () => {
    const f = okFetch()
    expect((await mk({}, f)(getReq("/send-status", `clientReference=${REF}`, { authorization: null }))).status).toBe(401)
    expect(f).not.toHaveBeenCalled()
  })

  it("501 without a disbursement account", async () => {
    const f = okFetch()
    expect((await mk({ disbursementAccount: undefined }, f)(getReq("/send-status", `clientReference=${REF}`))).status).toBe(501)
    expect(f).not.toHaveBeenCalled()
  })

  it("400 for an invalid clientReference, fetch never called", async () => {
    for (const q of ["", "clientReference=abc", `clientReference=${REF}x`, `clientReference=${REF.toUpperCase()}`]) {
      const f = okFetch()
      expect((await mk({}, f)(getReq("/send-status", q))).status).toBe(400)
      expect(f).not.toHaveBeenCalled()
    }
  })

  it("GETs smrsc with the disbursement account and the exact query, no body", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "success" }), { status: 200 }))
    const out = await mk({ sendBasicAuth: "SEND" }, f)(getReq("/send-status", `clientReference=${REF}`))
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe(`https://smrsc.hubtel.com/api/merchants/2025100/transactions/status?clientReference=${REF}`)
    expect(init.method).toBe("GET")
    expect(init.headers.Authorization).toBe("Basic SEND")
    expect(init.redirect).toBe("error")
    expect(init.body).toBeUndefined()
    expect(out.body).toEqual({ ok: true, upstreamStatus: 200, body: { ResponseCode: "success" } })
  })

  it("passes Hubtel's 400 no-match body through untouched", async () => {
    const nm = { ResponseCode: "error", Data: "Your status check did not match any records..." }
    const f = vi.fn(async () => new Response(JSON.stringify(nm), { status: 400 }))
    const out = await mk({}, f)(getReq("/send-status", `clientReference=${REF}`))
    expect(out.body).toEqual({ ok: false, upstreamStatus: 400, body: nm })
  })

  it("a throw reports upstreamStatus 0", async () => {
    const f = vi.fn(async () => { throw new Error("boom") })
    expect((await mk({}, f)(getReq("/send-status", `clientReference=${REF}`))).body).toMatchObject({ ok: false, upstreamStatus: 0 })
  })
})
