import { describe, it, expect, vi } from "vitest"
import {
  classifyStart, receiveMoney, initiateCheckout, checkPaymentStatus, hubtelCallbackUrl,
  toPesewas, HubtelPayInputError, type RelayReply,
} from "./client"
import { verifySig } from "@/lib/hubtel-cs/callback"

const REF = "0123456789abcdef0123456789abcdef"
const SECRET = "s".repeat(32)
const ENV = {
  HUBTEL_RELAY_URL: "https://relay.example.test/",
  HUBTEL_RELAY_SECRET: "relay-secret",
  HUBTEL_PAYMENTS_CALLBACK_SECRET: SECRET,
  NEXT_PUBLIC_APP_URL: "https://www.datagod.store",
}

const reply = (httpStatus: number, json: unknown): RelayReply => ({ kind: "reply", httpStatus, json })
const relay = (upstreamStatus: number, body: unknown, sent = true, ok = upstreamStatus >= 200 && upstreamStatus < 300) =>
  reply(200, { ok, upstreamStatus, body, sent })

describe("classifyStart — refused (safe to fall back)", () => {
  it("relay replied sent:false (never reached Hubtel)", () => {
    const o = classifyStart(relay(0, "fetch failed", false), "receive")
    expect(o.kind).toBe("refused")
  })
  it.each([400, 401, 403, 404, 422])("Hubtel HTTP %i", (s) => {
    expect(classifyStart(relay(s, { ResponseCode: "9999" }), "receive").kind).toBe("refused")
    expect(classifyStart(relay(s, { responseCode: "9999" }), "checkout").kind).toBe("refused")
  })
  it.each(["4000", "4070", "4101", "4103"])("receive code %s on HTTP 200", (code) => {
    const o = classifyStart(relay(200, { ResponseCode: code, Message: "nope" }), "receive")
    expect(o).toMatchObject({ kind: "refused", code })
  })
  it.each(["4000", "4070", "4101", "4103"])("checkout code %s on HTTP 200", (code) => {
    const o = classifyStart(relay(200, { responseCode: code, status: "Error" }), "checkout")
    expect(o).toMatchObject({ kind: "refused", code })
  })
  it("relay 501 (payments not configured)", () => {
    expect(classifyStart(reply(501, { error: "payments not configured" }), "checkout").kind).toBe("refused")
  })
  it("relay 401 (bearer rejected before routing)", () => {
    expect(classifyStart(reply(401, { error: "unauthorized" }), "receive").kind).toBe("refused")
  })
  it("relay not configured on Vercel", () => {
    expect(classifyStart({ kind: "not_configured" }, "receive").kind).toBe("refused")
  })
  it("relay connection refused / DNS failure before the request left Vercel", () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
    expect(classifyStart({ kind: "transport_error", error: e }, "receive").kind).toBe("refused")
    const d = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })
    expect(classifyStart({ kind: "transport_error", error: d }, "checkout").kind).toBe("refused")
  })
})

describe("classifyStart — accepted", () => {
  it("receive 0001 with transaction id", () => {
    const o = classifyStart(relay(200, { ResponseCode: "0001", Data: { TransactionId: "tx-1" } }), "receive")
    expect(o).toEqual({ kind: "accepted", hubtelTransactionId: "tx-1" })
  })
  it("receive 0001 on HTTP 202", () => {
    expect(classifyStart(relay(202, { ResponseCode: "0001", Data: {} }), "receive").kind).toBe("accepted")
  })
  it("checkout 0000 with checkoutUrl", () => {
    const o = classifyStart(relay(200, { responseCode: "0000", status: "Success", data: { checkoutUrl: "https://pay.hubtel.com/abc" } }), "checkout")
    expect(o).toEqual({ kind: "accepted", checkoutUrl: "https://pay.hubtel.com/abc" })
  })
})

describe("classifyStart — unknown (never fall back)", () => {
  it.each(["0005", "5000", "2001", "0000"])("receive code %s", (code) => {
    expect(classifyStart(relay(200, { ResponseCode: code }), "receive").kind).toBe("unknown")
  })
  it.each(["0005", "5000", "0001"])("checkout code %s", (code) => {
    expect(classifyStart(relay(200, { responseCode: code, data: { checkoutUrl: "https://pay.hubtel.com/x" } }), "checkout").kind).toBe("unknown")
  })
  it("checkout 0000 without a checkoutUrl", () => {
    expect(classifyStart(relay(200, { responseCode: "0000", data: {} }), "checkout").kind).toBe("unknown")
    expect(classifyStart(relay(200, { responseCode: "0000", data: { checkoutUrl: "" } }), "checkout").kind).toBe("unknown")
  })
  it("checkout 0000 with a non-https checkoutUrl", () => {
    expect(classifyStart(relay(200, { responseCode: "0000", data: { checkoutUrl: "http://pay.hubtel.com/x" } }), "checkout").kind).toBe("unknown")
  })
  it.each([500, 502, 503, 504])("Hubtel HTTP %i", (s) => {
    expect(classifyStart(relay(s, { ResponseCode: "4000" }), "receive").kind).toBe("unknown")
  })
  it("Hubtel 3xx", () => {
    expect(classifyStart(relay(302, "redirect"), "receive").kind).toBe("unknown")
  })
  it("relay timeout after send (sent:true, upstreamStatus 0)", () => {
    expect(classifyStart(relay(0, "The operation was aborted due to timeout", true), "receive").kind).toBe("unknown")
  })
  it("contradictory sent:false with a real upstream status", () => {
    expect(classifyStart(relay(200, { ResponseCode: "4000" }, false), "receive").kind).toBe("unknown")
  })
  it("malformed relay replies", () => {
    expect(classifyStart(reply(200, null), "receive").kind).toBe("unknown")
    expect(classifyStart(reply(200, "oops"), "receive").kind).toBe("unknown")
    expect(classifyStart(reply(200, { ok: true, upstreamStatus: 200, body: { ResponseCode: "0001" } }), "receive").kind).toBe("unknown") // no sent
    expect(classifyStart(reply(200, { ok: true, sent: true, body: { ResponseCode: "0001" } }), "receive").kind).toBe("unknown") // no upstreamStatus
    expect(classifyStart(relay(200, "not json"), "receive").kind).toBe("unknown")
    expect(classifyStart(relay(200, { ResponseCode: 1 }), "receive").kind).toBe("unknown")
  })
  it.each([404, 500, 502, 503, 504])("relay/proxy HTTP %i (cannot tell if sent)", (s) => {
    expect(classifyStart(reply(s, { error: "x" }), "receive").kind).toBe("unknown")
  })
  it("transport timeout / reset talking to the relay", () => {
    const t = Object.assign(new Error("timeout"), { name: "TimeoutError" })
    expect(classifyStart({ kind: "transport_error", error: t }, "receive").kind).toBe("unknown")
    const r = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })
    expect(classifyStart({ kind: "transport_error", error: r }, "receive").kind).toBe("unknown")
    expect(classifyStart({ kind: "transport_error", error: "weird" }, "checkout").kind).toBe("unknown")
  })
  it("uses the Hubtel code as the outcome code when present", () => {
    expect(classifyStart(relay(200, { ResponseCode: "0005", Message: "pending" }), "receive")).toMatchObject({ kind: "unknown", code: "0005" })
  })
})

describe("classifyStart — relay validation 400 is a programming bug", () => {
  it("throws HubtelPayInputError", () => {
    expect(() => classifyStart(reply(400, { error: "invalid msisdn" }), "receive")).toThrow(HubtelPayInputError)
    expect(() => classifyStart(reply(400, { error: "invalid msisdn" }), "receive")).toThrow(/invalid msisdn/)
  })
})

function fakeFetch(status: number, json: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } }))
}

describe("receiveMoney", () => {
  const base = { reference: REF, msisdn: "233241234567", channel: "mtn-gh", amount: 12.5, description: "Datagod payment", callbackUrl: "https://www.datagod.store/api/webhooks/hubtel-payments?ref=x&sig=y" }

  it("posts to the relay /receive with bearer and the exact body", async () => {
    const f = fakeFetch(200, { ok: true, upstreamStatus: 200, body: { ResponseCode: "0001", Data: { TransactionId: "t9" } }, sent: true })
    const o = await receiveMoney(base, { fetchImpl: f, env: ENV })
    expect(o).toEqual({ kind: "accepted", hubtelTransactionId: "t9" })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe("https://relay.example.test/receive")
    expect(init?.method).toBe("POST")
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer relay-secret")
    expect(JSON.parse(String(init?.body))).toEqual(base)
    expect(init?.redirect).toBe("error")
  })

  it.each([0.1 + 0.2, 1.005, 12.345, Number.NaN, Infinity, 0, -5, "10" as unknown as number])("throws on amount %s before calling", async (amount) => {
    const f = fakeFetch(200, {})
    await expect(receiveMoney({ ...base, amount }, { fetchImpl: f, env: ENV })).rejects.toThrow(HubtelPayInputError)
    expect(f).not.toHaveBeenCalled()
  })

  it("relay not configured → refused, no fetch", async () => {
    const f = fakeFetch(200, {})
    const o = await receiveMoney(base, { fetchImpl: f, env: { ...ENV, HUBTEL_RELAY_URL: "" } })
    expect(o.kind).toBe("refused")
    expect(f).not.toHaveBeenCalled()
  })

  it("fetch throwing a timeout → unknown", async () => {
    const f = vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }) })
    expect((await receiveMoney(base, { fetchImpl: f, env: ENV })).kind).toBe("unknown")
  })

  it("non-JSON relay reply → unknown", async () => {
    const f = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 200 }))
    expect((await receiveMoney(base, { fetchImpl: f, env: ENV })).kind).toBe("unknown")
  })

  it("relay 400 → throws", async () => {
    const f = fakeFetch(400, { error: "invalid channel" })
    await expect(receiveMoney(base, { fetchImpl: f, env: ENV })).rejects.toThrow(HubtelPayInputError)
  })
})

describe("initiateCheckout", () => {
  const base = {
    reference: REF, amount: 199.99, description: "Datagod payment",
    callbackUrl: "https://www.datagod.store/api/webhooks/hubtel-payments?ref=x&sig=y",
    returnUrl: "https://www.datagod.store/pay/return", cancellationUrl: "https://www.datagod.store/pay/cancel",
  }
  it("posts to /checkout and returns the checkoutUrl", async () => {
    const f = fakeFetch(200, { ok: true, upstreamStatus: 200, sent: true, body: { responseCode: "0000", status: "Success", data: { checkoutUrl: "https://pay.hubtel.com/c1", checkoutId: "c1" } } })
    const o = await initiateCheckout(base, { fetchImpl: f, env: ENV })
    expect(o).toEqual({ kind: "accepted", checkoutUrl: "https://pay.hubtel.com/c1" })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe("https://relay.example.test/checkout")
    expect(JSON.parse(String(init?.body))).toEqual(base)
  })
  it("throws on a non-2dp amount before calling", async () => {
    const f = fakeFetch(200, {})
    await expect(initiateCheckout({ ...base, amount: 199.999 }, { fetchImpl: f, env: ENV })).rejects.toThrow(HubtelPayInputError)
    expect(f).not.toHaveBeenCalled()
  })
  it("relay 501 → refused", async () => {
    const f = fakeFetch(501, { error: "payments not configured" })
    expect((await initiateCheckout(base, { fetchImpl: f, env: ENV })).kind).toBe("refused")
  })
})

describe("toPesewas", () => {
  it("converts exactly", () => {
    expect(toPesewas(0.8)).toBe(80)
    expect(toPesewas(199.99)).toBe(19999)
    expect(toPesewas(0.1)).toBe(10)
    expect(toPesewas(10000)).toBe(1000000)
  })
})

describe("checkPaymentStatus", () => {
  const paid = { ok: true, status: "Paid", upstreamStatus: 200, data: { status: "Paid", amount: 0.8, charges: 0.02, paymentMethod: "mobilemoney", transactionId: "h1" }, body: { responseCode: "0000" } }

  it("Paid → paid with pesewas fields", async () => {
    const r = await checkPaymentStatus(REF, { checkStatus: async () => paid })
    expect(r).toMatchObject({ kind: "paid", amountPesewas: 80, chargesPesewas: 2, paymentMethod: "mobilemoney", transactionId: "h1" })
    expect(r.raw).toBe(paid)
  })
  it("199.99 → 19999 pesewas", async () => {
    const r = await checkPaymentStatus(REF, { checkStatus: async () => ({ ...paid, data: { ...paid.data, amount: 199.99 } }) })
    expect(r.amountPesewas).toBe(19999)
  })
  it("passes the reference through", async () => {
    const cs = vi.fn(async () => paid)
    await checkPaymentStatus(REF, { checkStatus: cs })
    expect(cs).toHaveBeenCalledWith(REF)
  })
  it("Unpaid → unpaid", async () => {
    const r = await checkPaymentStatus(REF, { checkStatus: async () => ({ ok: true, status: "Unpaid", data: { status: "Unpaid", amount: 1 } }) })
    expect(r.kind).toBe("unpaid")
  })
  it("Refunded → refunded", async () => {
    const r = await checkPaymentStatus(REF, { checkStatus: async () => ({ ok: true, status: "Refunded", data: { status: "Refunded" } }) })
    expect(r.kind).toBe("refunded")
  })
  it("Hubtel 404 → not_found", async () => {
    const r = await checkPaymentStatus(REF, { checkStatus: async () => ({ ok: false, error: "relay/hubtel 404", upstreamStatus: 404, body: { message: "payment record not found" } }) })
    expect(r.kind).toBe("not_found")
  })
  it("relay's own route 404 is not mistaken for Hubtel's → error", async () => {
    const r = await checkPaymentStatus(REF, { checkStatus: async () => ({ ok: false, error: "relay/hubtel 404", upstreamStatus: 404, body: { error: "not found" } }) })
    expect(r.kind).toBe("error")
  })
  it.each([
    { ok: false, error: "relay not configured" },
    { ok: false, error: "relay/hubtel 500", upstreamStatus: 500, body: "boom" },
    { ok: false, error: "timeout" },
    { ok: true, status: "Pending", data: { status: "Pending" } },
    { ok: true, status: undefined, data: undefined },
  ])("everything else → error (%o)", async (res) => {
    const r = await checkPaymentStatus(REF, { checkStatus: async () => res })
    expect(r.kind).toBe("error")
  })
  it("Paid with a non-numeric amount → error (never paid without an amount)", async () => {
    const r = await checkPaymentStatus(REF, { checkStatus: async () => ({ ...paid, data: { ...paid.data, amount: "0.8" } }) })
    expect(r.kind).toBe("error")
  })
  it("a throwing status check → error", async () => {
    const r = await checkPaymentStatus(REF, { checkStatus: async () => { throw new Error("x") } })
    expect(r.kind).toBe("error")
  })
})

describe("hubtelCallbackUrl", () => {
  it("builds a signed URL on the app host", () => {
    const u = new URL(hubtelCallbackUrl(REF, ENV))
    expect(u.origin).toBe("https://www.datagod.store")
    expect(u.pathname).toBe("/api/webhooks/hubtel-payments")
    expect(u.searchParams.get("ref")).toBe(REF)
    expect(verifySig(REF, u.searchParams.get("sig"), SECRET)).toBe(true)
  })
  it("tolerates a trailing slash on the app URL", () => {
    expect(hubtelCallbackUrl(REF, { ...ENV, NEXT_PUBLIC_APP_URL: "https://www.datagod.store/" }).startsWith("https://www.datagod.store/api/webhooks/hubtel-payments?")).toBe(true)
  })
  it("throws when the secret is missing or shorter than 32 chars", () => {
    expect(() => hubtelCallbackUrl(REF, { ...ENV, HUBTEL_PAYMENTS_CALLBACK_SECRET: "" })).toThrow(/HUBTEL_PAYMENTS_CALLBACK_SECRET/)
    expect(() => hubtelCallbackUrl(REF, { ...ENV, HUBTEL_PAYMENTS_CALLBACK_SECRET: "x".repeat(31) })).toThrow(/HUBTEL_PAYMENTS_CALLBACK_SECRET/)
  })
  it("throws when the app URL is missing or not https", () => {
    expect(() => hubtelCallbackUrl(REF, { ...ENV, NEXT_PUBLIC_APP_URL: "" })).toThrow(/NEXT_PUBLIC_APP_URL/)
    expect(() => hubtelCallbackUrl(REF, { ...ENV, NEXT_PUBLIC_APP_URL: "http://www.datagod.store" })).toThrow(/NEXT_PUBLIC_APP_URL/)
  })
  it("rejects a malformed reference", () => {
    expect(() => hubtelCallbackUrl("WALLET-1", ENV)).toThrow(HubtelPayInputError)
  })
})
