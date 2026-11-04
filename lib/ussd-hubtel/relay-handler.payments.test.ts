// lib/ussd-hubtel/relay-handler.payments.test.ts
// Relay routes /receive (Direct Receive Money) and /checkout (Online Checkout).
import { describe, expect, it, vi } from "vitest"
import { createRelayHandler } from "./relay-handler"

const REF = "0123456789abcdef0123456789abcdef"
const CB = `https://www.datagod.store/api/webhooks/hubtel-payments?ref=${REF}&sig=abc`
const RET = "https://www.datagod.store/pay/return"
const CANCEL = "https://www.datagod.store/pay/cancel"

const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "0001" }), { status: 200 }))
const mk = (over: any = {}, fetchImpl?: any) =>
  createRelayHandler({
    secret: "rs", collectionAccount: "11684", statusBasicAuth: "STATUS", appHost: "www.datagod.store",
    fetchImpl: fetchImpl ?? okFetch(),
    ...over,
  })

const receiveBody = (over: any = {}) => ({
  reference: REF, msisdn: "233241234567", channel: "mtn-gh", amount: 12.5, description: "Order payment", callbackUrl: CB, ...over,
})
const checkoutBody = (over: any = {}) => ({
  reference: REF, amount: 12.5, description: "Order payment", callbackUrl: CB, returnUrl: RET, cancellationUrl: CANCEL, ...over,
})
const req = (path: string, body: unknown, over: any = {}) => ({
  method: "POST", path, query: new URLSearchParams(), authorization: "Bearer rs",
  body: typeof body === "string" ? body : JSON.stringify(body), ...over,
})

function connErr(code: string) {
  const e: any = new TypeError("fetch failed")
  e.cause = Object.assign(new Error(`connect ${code}`), { code })
  return e
}

describe("relay /receive", () => {
  it("401 without the bearer secret, nothing sent", async () => {
    const f = okFetch()
    expect((await mk({}, f)(req("/receive", receiveBody(), { authorization: null }))).status).toBe(401)
    expect((await mk({}, f)(req("/receive", receiveBody(), { authorization: "Bearer nope" }))).status).toBe(401)
    expect(f).not.toHaveBeenCalled()
  })

  it("501 when appHost is not configured", async () => {
    const f = okFetch()
    const out = await mk({ appHost: undefined }, f)(req("/receive", receiveBody()))
    expect(out.status).toBe(501)
    expect(f).not.toHaveBeenCalled()
  })

  it("forwards exact URL, headers and body to Hubtel", async () => {
    const f = okFetch()
    const out = await mk({}, f)(req("/receive", receiveBody({ extra: "dropped" })))
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://rmp.hubtel.com/merchantaccount/merchants/11684/receive/mobilemoney")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      Authorization: "Basic STATUS", Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-cache",
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body)).toEqual({
      CustomerMsisdn: "233241234567", Channel: "mtn-gh", Amount: 12.5, PrimaryCallbackURL: CB,
      Description: "Order payment", ClientReference: REF,
    })
    expect(out).toEqual({ status: 200, body: { ok: true, upstreamStatus: 200, body: { ResponseCode: "0001" }, sent: true } })
  })

  it("uses receiveBasicAuth when set", async () => {
    const f = okFetch()
    await mk({ receiveBasicAuth: "RECV" }, f)(req("/receive", receiveBody()))
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe("Basic RECV")
  })

  it("passes a Hubtel 4xx through as ok:false, sent:true", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "4000" }), { status: 400 }))
    const out = await mk({}, f)(req("/receive", receiveBody()))
    expect(out).toEqual({ status: 200, body: { ok: false, upstreamStatus: 400, body: { ResponseCode: "4000" }, sent: true } })
  })

  const bad: Array<[string, any]> = [
    ["reference uppercase", { reference: REF.toUpperCase() }],
    ["reference short", { reference: "abc" }],
    ["reference prefixed", { reference: `WALLET-${REF}` }],
    ["reference missing", { reference: undefined }],
    ["msisdn local format", { msisdn: "0241234567" }],
    ["msisdn too long", { msisdn: "2332412345678" }],
    ["msisdn number type", { msisdn: 233241234567 }],
    ["channel unknown", { channel: "airtel-gh" }],
    ["channel missing", { channel: undefined }],
    ["amount string", { amount: "12.50" }],
    ["amount 3 decimals", { amount: 1.234 }],
    ["amount below 0.10", { amount: 0.09 }],
    ["amount above 10000", { amount: 10000.01 }],
    ["amount NaN-ish", { amount: null }],
    ["description special chars", { description: "Pay & go!" }],
    ["description empty", { description: "" }],
    ["description too long", { description: "a".repeat(61) }],
    ["callbackUrl http", { callbackUrl: CB.replace("https:", "http:") }],
    ["callbackUrl not a url", { callbackUrl: "nope" }],
    ["callbackUrl other host", { callbackUrl: "https://evil.example/api/webhooks/hubtel-payments" }],
    ["callbackUrl lookalike host", { callbackUrl: "https://www.datagod.store.evil.example/cb" }],
    ["callbackUrl with credentials", { callbackUrl: "https://u:p@www.datagod.store/cb" }],
    ["callbackUrl too long", { callbackUrl: `https://www.datagod.store/${"a".repeat(480)}` }],
  ]
  for (const [name, over] of bad) {
    it(`400 and nothing sent: ${name}`, async () => {
      const f = okFetch()
      const out = await mk({}, f)(req("/receive", receiveBody(over)))
      expect(out.status).toBe(400)
      expect(f).not.toHaveBeenCalled()
    })
  }

  it("accepts the amount bounds 0.10 and 10000 and 2-decimal values", async () => {
    for (const amount of [0.1, 10000, 199.99, 0.8]) {
      const f = okFetch()
      expect((await mk({}, f)(req("/receive", receiveBody({ amount })))).status).toBe(200)
      expect(JSON.parse((f.mock.calls[0] as any)[1].body).Amount).toBe(amount)
    }
  })

  it("400 on invalid json or a non-object body", async () => {
    const f = okFetch()
    expect((await mk({}, f)(req("/receive", "{nope"))).status).toBe(400)
    expect((await mk({}, f)(req("/receive", "[1]"))).status).toBe(400)
    expect((await mk({}, f)(req("/receive", "null"))).status).toBe(400)
    expect(f).not.toHaveBeenCalled()
  })

  it("a connection-level failure before sending → upstreamStatus 0, sent:false", async () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
      const out: any = await mk({}, async () => { throw connErr(code) })(req("/receive", receiveBody()))
      expect(out.status).toBe(200)
      expect(out.body).toMatchObject({ ok: false, upstreamStatus: 0, sent: false })
    }
  })

  it("a timeout after sending → sent:true", async () => {
    const f = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError") }
    const out: any = await mk({}, f)(req("/receive", receiveBody()))
    expect(out.body).toMatchObject({ ok: false, upstreamStatus: 0, sent: true })
  })

  it("an abort, a reset, or an unrecognised error → sent:true (safe side)", async () => {
    const errs = [
      new DOMException("aborted", "AbortError"),
      connErr("ECONNRESET"),
      connErr("UND_ERR_SOCKET"),
      new Error("something odd"),
      "a string",
    ]
    for (const e of errs) {
      const out: any = await mk({}, async () => { throw e })(req("/receive", receiveBody()))
      expect(out.body).toMatchObject({ ok: false, upstreamStatus: 0, sent: true })
    }
  })

  it("a body-read failure after a response → sent:true with the upstream status", async () => {
    const f = async () => ({ ok: true, status: 200, text: async () => { throw new Error("terminated") } }) as any
    const out: any = await mk({}, f)(req("/receive", receiveBody()))
    expect(out.body).toMatchObject({ ok: false, sent: true })
  })
})

describe("relay /checkout", () => {
  it("401 without the bearer secret, nothing sent", async () => {
    const f = okFetch()
    expect((await mk({}, f)(req("/checkout", checkoutBody(), { authorization: null }))).status).toBe(401)
    expect(f).not.toHaveBeenCalled()
  })

  it("501 when appHost is not configured", async () => {
    const f = okFetch()
    expect((await mk({ appHost: "" }, f)(req("/checkout", checkoutBody()))).status).toBe(501)
    expect(f).not.toHaveBeenCalled()
  })

  it("forwards exact URL, headers and body to Hubtel", async () => {
    const upstream = { responseCode: "0000", status: "Success", data: { checkoutUrl: "https://pay.hubtel.com/x", clientReference: REF } }
    const f = vi.fn(async () => new Response(JSON.stringify(upstream), { status: 200 }))
    const out = await mk({}, f)(req("/checkout", checkoutBody({ extra: "dropped" })))
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://payproxyapi.hubtel.com/items/initiate")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      Authorization: "Basic STATUS", Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-cache",
    })
    expect(JSON.parse(init.body)).toEqual({
      totalAmount: 12.5, description: "Order payment", callbackUrl: CB, returnUrl: RET, cancellationUrl: CANCEL,
      merchantAccountNumber: "11684", clientReference: REF,
    })
    expect(out).toEqual({ status: 200, body: { ok: true, upstreamStatus: 200, body: upstream, sent: true } })
  })

  it("uses receiveBasicAuth when set and honours base URL override", async () => {
    const f = okFetch()
    await mk({ receiveBasicAuth: "RECV", checkoutBaseUrl: "https://checkout.test/" }, f)(req("/checkout", checkoutBody()))
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://checkout.test/items/initiate")
    expect(init.headers.Authorization).toBe("Basic RECV")
  })

  const bad: Array<[string, any]> = [
    ["reference bad", { reference: "inv0012" }],
    ["amount 3 decimals", { amount: 5.555 }],
    ["amount zero", { amount: 0 }],
    ["amount negative", { amount: -1 }],
    ["description special chars", { description: "Book <shop>" }],
    ["callbackUrl other host", { callbackUrl: "https://evil.example/cb" }],
    ["returnUrl http", { returnUrl: "http://www.datagod.store/pay/return" }],
    ["returnUrl missing", { returnUrl: undefined }],
    ["returnUrl too long", { returnUrl: `https://www.datagod.store/${"a".repeat(480)}` }],
    ["cancellationUrl not a url", { cancellationUrl: "javascript:alert(1)" }],
    ["cancellationUrl missing", { cancellationUrl: undefined }],
  ]
  for (const [name, over] of bad) {
    it(`400 and nothing sent: ${name}`, async () => {
      const f = okFetch()
      const out = await mk({}, f)(req("/checkout", checkoutBody(over)))
      expect(out.status).toBe(400)
      expect(f).not.toHaveBeenCalled()
    })
  }

  it("a connection failure before sending → sent:false; a timeout → sent:true", async () => {
    const a: any = await mk({}, async () => { throw connErr("ECONNREFUSED") })(req("/checkout", checkoutBody()))
    expect(a.body).toMatchObject({ ok: false, upstreamStatus: 0, sent: false })
    const b: any = await mk({}, async () => { throw new DOMException("t", "TimeoutError") })(req("/checkout", checkoutBody()))
    expect(b.body).toMatchObject({ ok: false, upstreamStatus: 0, sent: true })
  })

  it("GET is not routed", async () => {
    const f = okFetch()
    expect((await mk({}, f)(req("/checkout", checkoutBody(), { method: "GET" }))).status).toBe(404)
    expect(f).not.toHaveBeenCalled()
  })
})
