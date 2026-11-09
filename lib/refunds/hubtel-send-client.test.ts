import { describe, expect, it, vi } from "vitest"
import {
  classifySend, classifySendStatus, hubtelChannelFor, hubtelSendCallbackUrl, readSendStatus, sendMoney, checkSendStatus,
  sendRefundReference, toHubtelMsisdn, verifySendSig,
} from "./hubtel-send-client"
import type { RelayReply } from "@/lib/hubtel-pay/client"

const UUID = "3F2504E0-4F89-41D3-9A0C-0305E82C3301"
const REF = "3f2504e04f8941d39a0c0305e82c3301"

const relay = (json: unknown, httpStatus = 200): RelayReply => ({ kind: "reply", httpStatus, json })
const sent = (upstreamStatus: number, body: unknown) => relay({ ok: upstreamStatus >= 200 && upstreamStatus < 300, upstreamStatus, body, sent: true })

// The docs' sample replies.
const ACCEPTED = { ResponseCode: "0001", Data: { AmountDebited: 0.0, TransactionId: "8a545e5c7357714b80b65f76", Description: "Your request has been accepted. We will notify you when the transaction is completed.", ClientReference: REF, ExternalTransactionId: "", Amount: 10.0, Charges: 0.0, Meta: null, RecipientName: null } }
const code = (c: string) => ({ ResponseCode: c, Data: { Description: "x", ClientReference: REF } })

describe("sendRefundReference", () => {
  it("is the refund UUID without dashes, lowercase, 32 hex", () => {
    expect(sendRefundReference(UUID)).toBe(REF)
    expect(sendRefundReference(UUID.toLowerCase())).toBe(REF)
    expect(sendRefundReference(UUID)).toBe(sendRefundReference(UUID)) // same on any repeat
  })
  it.each(["", "rf-1", "not-a-uuid", `${UUID}0`, "3f2504e0-4f89-41d3-9a0c-0305e82c330", "3f2504e04f8941d39a0c0305e82c3301", "zf2504e0-4f89-41d3-9a0c-0305e82c3301"])("throws on %j", (v) => {
    expect(() => sendRefundReference(v)).toThrow()
  })
  it("throws on a non-string", () => { expect(() => sendRefundReference(undefined as any)).toThrow() })
})

describe("msisdn and channel", () => {
  it("converts any Ghana format to 233XXXXXXXXX", () => {
    expect(toHubtelMsisdn("0241234567")).toBe("233241234567")
    expect(toHubtelMsisdn("+233241234567")).toBe("233241234567")
    expect(toHubtelMsisdn("12345")).toBeNull()
  })
  it("maps networks to Hubtel channels via detectGhanaNetwork", () => {
    expect(hubtelChannelFor("0241234567")).toBe("mtn-gh")
    expect(hubtelChannelFor("0201234567")).toBe("vodafone-gh")
    expect(hubtelChannelFor("0261234567")).toBe("tigo-gh")
    expect(hubtelChannelFor("0111234567")).toBeNull()
  })
})

describe("classifySend", () => {
  it("0001 accepted -> pending with the Hubtel transaction id", () => {
    expect(classifySend(sent(200, ACCEPTED), REF)).toEqual({ kind: "pending", ref: "8a545e5c7357714b80b65f76" })
  })
  it("0001 without a transaction id still pends, on our own reference", () => {
    expect(classifySend(sent(200, { ResponseCode: "0001", Data: {} }), REF)).toEqual({ kind: "pending", ref: REF })
  })
  it("0000 -> completed", () => {
    expect(classifySend(sent(200, { ResponseCode: "0000", Data: { TransactionId: "t1" } }), REF)).toEqual({ kind: "completed", ref: "t1" })
  })
  it.each(["4075", "3050", "4000"])("%s -> failed (nothing sent)", (c) => {
    expect(classifySend(sent(400, code(c)), REF).kind).toBe("failed")
    expect(classifySend(sent(200, code(c)), REF).kind).toBe("failed")
  })
  it.each(["2001", "5000", "9999", "0005"])("%s -> unknown", (c) => {
    expect(classifySend(sent(200, code(c)), REF).kind).toBe("unknown")
    expect(classifySend(sent(400, code(c)), REF).kind).toBe("unknown")
  })
  it("any 5xx is unknown, even with a failure code in the body", () => {
    expect(classifySend(sent(500, "Internal Server Error"), REF).kind).toBe("unknown")
    expect(classifySend(sent(502, code("4075")), REF).kind).toBe("unknown")
    expect(classifySend(sent(503, code("4000")), REF).kind).toBe("unknown")
  })
  it.each([401, 403, 404, 405])("HTTP %i with no acceptance -> failed", (s) => {
    expect(classifySend(sent(s, "Forbidden"), REF).kind).toBe("failed")
    expect(classifySend(sent(s, { message: "no" }), REF).kind).toBe("failed")
  })
  it("a refused HTTP status contradicted by an accepted code is unknown", () => {
    expect(classifySend(sent(403, ACCEPTED), REF).kind).toBe("unknown")
    expect(classifySend(sent(404, { ResponseCode: "0000" }), REF).kind).toBe("unknown")
  })
  it("relay sent:false (provably never left) -> failed", () => {
    expect(classifySend(relay({ ok: false, upstreamStatus: 0, body: "fetch failed", sent: false }), REF).kind).toBe("failed")
  })
  it("a timeout after sending (sent:true, upstream 0) -> unknown", () => {
    expect(classifySend(relay({ ok: false, upstreamStatus: 0, body: "timed out", sent: true }), REF).kind).toBe("unknown")
  })
  it("sent:false with a Hubtel status is contradictory -> unknown", () => {
    expect(classifySend(relay({ ok: false, upstreamStatus: 200, body: {}, sent: false }), REF).kind).toBe("unknown")
  })
  it("2xx with an unreadable body or no code -> unknown", () => {
    expect(classifySend(sent(200, "<html>"), REF).kind).toBe("unknown")
    expect(classifySend(sent(200, null), REF).kind).toBe("unknown")
    expect(classifySend(sent(200, { Data: {} }), REF).kind).toBe("unknown")
    expect(classifySend(sent(200, { ResponseCode: 1 }), REF).kind).toBe("unknown")
  })
  it("a malformed relay reply (no sent flag) -> unknown", () => {
    expect(classifySend(relay({ ok: true, upstreamStatus: 200, body: ACCEPTED }), REF).kind).toBe("unknown")
    expect(classifySend(relay("garbage"), REF).kind).toBe("unknown")
    expect(classifySend(relay(null), REF).kind).toBe("unknown")
  })
  it("the relay's own 401/501/400 (before anything left it) -> failed", () => {
    expect(classifySend(relay({ error: "unauthorized" }, 401), REF).kind).toBe("failed")
    expect(classifySend(relay({ error: "send not configured" }, 501), REF).kind).toBe("failed")
    expect(classifySend(relay({ error: "invalid amount" }, 400), REF).kind).toBe("failed")
  })
  it("other relay statuses (502, 500) -> unknown", () => {
    expect(classifySend(relay("bad gateway", 502), REF).kind).toBe("unknown")
    expect(classifySend(relay({ error: "internal error" }, 500), REF).kind).toBe("unknown")
  })
  it("relay not configured -> failed; unreachable relay -> failed; mid-flight transport error -> unknown", () => {
    expect(classifySend({ kind: "not_configured" }, REF).kind).toBe("failed")
    const conn: any = new TypeError("fetch failed"); conn.cause = Object.assign(new Error("x"), { code: "ECONNREFUSED" })
    expect(classifySend({ kind: "transport_error", error: conn }, REF).kind).toBe("failed")
    expect(classifySend({ kind: "transport_error", error: Object.assign(new Error("t"), { name: "TimeoutError" }) }, REF).kind).toBe("unknown")
    expect(classifySend({ kind: "transport_error", error: new Error("reset") }, REF).kind).toBe("unknown")
  })
  it("messages carry no msisdn", () => {
    const out = classifySend(sent(400, { ResponseCode: "3050", Data: { Description: "Mobile Number is not registered", RecipientName: "233241234567" } }), REF)
    expect(JSON.stringify(out)).not.toContain("233241234567")
  })
})

describe("classifySendStatus", () => {
  const ok = (over: any = {}) => sent(200, { ResponseCode: "success", Data: { TransactionId: "t9", networkTransactionId: "142", Amount: 12.5, Fees: 0.1, ClientReference: REF, Channel: "mtn-gh", CustomerNumber: "233241234567", transactionStatus: "success", CreatedAt: "2026-11-05 10:00:00", ...over } })
  const want = { reference: REF, amount: 12.5 }

  it("success for our reference and amount -> completed", () => {
    expect(classifySendStatus(ok(), want)).toEqual({ kind: "completed", ref: "t9" })
  })
  it("success matches case-insensitively", () => {
    expect(classifySendStatus(ok({ transactionStatus: "Success" }), want).kind).toBe("completed")
  })
  it("success for ANOTHER reference never completes", () => {
    expect(classifySendStatus(ok({ ClientReference: "f".repeat(32) }), want).kind).not.toBe("completed")
  })
  it("success with a different amount is parked, not completed", () => {
    expect(classifySendStatus(ok({ Amount: 99 }), want).kind).toBe("unknown")
  })
  it("success with no amount in the reply is parked", () => {
    expect(classifySendStatus(ok({ Amount: undefined }), want).kind).toBe("unknown")
  })
  it("a clearly failed status for our reference -> failed", () => {
    expect(classifySendStatus(ok({ transactionStatus: "failed" }), want).kind).toBe("failed")
    expect(classifySendStatus(ok({ transactionStatus: "FAILED" }), want).kind).toBe("failed")
  })
  it("a failed status for another reference is not a failure of ours", () => {
    expect(classifySendStatus(ok({ transactionStatus: "failed", ClientReference: "f".repeat(32) }), want).kind).toBe("pending")
  })
  it.each(["pending", "processing", "unknown", "declined", "reversed", "", 7, null])("status %j stays pending (allowlist)", (s) => {
    expect(classifySendStatus(ok({ transactionStatus: s }), want).kind).toBe("pending")
  })
  it("Hubtel's live 400 no-match reply stays pending", () => {
    const r = sent(400, { ResponseCode: "error", Data: "Your status check did not match any records..." })
    expect(classifySendStatus(r, want)).toMatchObject({ kind: "pending" })
  })
  it("any other Hubtel answer stays pending", () => {
    expect(classifySendStatus(sent(500, "oops"), want).kind).toBe("pending")
    expect(classifySendStatus(sent(200, "<html>"), want).kind).toBe("pending")
    expect(classifySendStatus(sent(200, { ResponseCode: "success" }), want).kind).toBe("pending")
  })
  it("no answer at all (relay down, timeout, not configured) is unknown with a reason, never failed", () => {
    expect(classifySendStatus({ kind: "not_configured" }, want).kind).toBe("unknown")
    expect(classifySendStatus({ kind: "transport_error", error: new Error("x") }, want).kind).toBe("unknown")
    expect(classifySendStatus(relay({ ok: false, upstreamStatus: 0, body: "timeout" }), want).kind).toBe("unknown")
    expect(classifySendStatus(relay({ error: "unauthorized" }, 401), want).kind).toBe("unknown")
  })
  it("pending outcomes keep our reference as ref", () => {
    expect(classifySendStatus(sent(400, { ResponseCode: "error", Data: "no" }), want)).toEqual({ kind: "pending", ref: REF })
  })
})

describe("callback URL", () => {
  const env = { NEXT_PUBLIC_APP_URL: "https://www.datagod.store", HUBTEL_PAYMENTS_CALLBACK_SECRET: "s".repeat(40) }
  it("carries ref and a sig that verifies, on the /api/webhooks/hubtel-send path", () => {
    const u = new URL(hubtelSendCallbackUrl(REF, env))
    expect(u.pathname).toBe("/api/webhooks/hubtel-send")
    expect(u.searchParams.get("ref")).toBe(REF)
    expect(verifySendSig(REF, u.searchParams.get("sig"), env.HUBTEL_PAYMENTS_CALLBACK_SECRET)).toBe(true)
  })
  it("the sig is domain-separated from the collection callback and return signatures", async () => {
    const { signRef } = await import("@/lib/hubtel-cs/callback")
    expect(verifySendSig(REF, signRef(REF, env.HUBTEL_PAYMENTS_CALLBACK_SECRET), env.HUBTEL_PAYMENTS_CALLBACK_SECRET)).toBe(false)
    expect(verifySendSig(REF, signRef(`return:${REF}`, env.HUBTEL_PAYMENTS_CALLBACK_SECRET), env.HUBTEL_PAYMENTS_CALLBACK_SECRET)).toBe(false)
    expect(verifySendSig("f".repeat(32), new URL(hubtelSendCallbackUrl(REF, env)).searchParams.get("sig"), env.HUBTEL_PAYMENTS_CALLBACK_SECRET)).toBe(false)
  })
  it("refuses to build without the secret or an https app url", () => {
    expect(() => hubtelSendCallbackUrl(REF, { ...env, HUBTEL_PAYMENTS_CALLBACK_SECRET: "short" })).toThrow()
    expect(() => hubtelSendCallbackUrl(REF, { ...env, NEXT_PUBLIC_APP_URL: "http://x.test" })).toThrow()
    expect(() => hubtelSendCallbackUrl("nope", env)).toThrow()
  })
})

describe("sendMoney / checkSendStatus (relay calls)", () => {
  const env = { HUBTEL_RELAY_URL: "https://relay.test/", HUBTEL_RELAY_SECRET: "rs", NEXT_PUBLIC_APP_URL: "https://www.datagod.store", HUBTEL_PAYMENTS_CALLBACK_SECRET: "s".repeat(40) }
  const p = { refundId: UUID, msisdn: "233241234567", channel: "mtn-gh", amount: 12.5 }
  it("posts the fixed payload to /send and classifies the reply", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, upstreamStatus: 200, body: ACCEPTED, sent: true }), { status: 200 }))
    const out = await sendMoney(p, { fetchImpl: f as any, env })
    expect(out).toEqual({ kind: "pending", ref: "8a545e5c7357714b80b65f76" })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://relay.test/send")
    expect(init.redirect).toBe("error")
    expect(init.headers.Authorization).toBe("Bearer rs")
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ reference: REF, msisdn: "233241234567", channel: "mtn-gh", amount: 12.5 })
    expect(Object.keys(body).sort()).toEqual(["amount", "callbackUrl", "channel", "msisdn", "reference"])
    expect(body.callbackUrl).toContain(`/api/webhooks/hubtel-send?ref=${REF}&sig=`)
  })
  it("a relay that cannot be reached is failed (nothing sent); a thrown timeout is unknown", async () => {
    const conn: any = new TypeError("fetch failed"); conn.cause = Object.assign(new Error("x"), { code: "ENOTFOUND" })
    expect((await sendMoney(p, { fetchImpl: (async () => { throw conn }) as any, env })).kind).toBe("failed")
    expect((await sendMoney(p, { fetchImpl: (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }) }) as any, env })).kind).toBe("unknown")
  })
  it("a missing callback secret is failed before anything is sent", async () => {
    const f = vi.fn()
    const out = await sendMoney(p, { fetchImpl: f as any, env: { ...env, HUBTEL_PAYMENTS_CALLBACK_SECRET: undefined } })
    expect(out.kind).toBe("failed")
    expect(f).not.toHaveBeenCalled()
  })
  it("a bad amount is failed before anything is sent", async () => {
    const f = vi.fn()
    for (const amount of [0, -1, 1.005, NaN]) {
      expect((await sendMoney({ ...p, amount }, { fetchImpl: f as any, env })).kind).toBe("failed")
    }
    expect(f).not.toHaveBeenCalled()
  })
  it("checkSendStatus GETs /send-status with the reference", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, upstreamStatus: 200, body: { ResponseCode: "success", Data: { ClientReference: REF, Amount: 5, transactionStatus: "success", TransactionId: "t1" } } }), { status: 200 }))
    const out = await checkSendStatus({ refundId: UUID, amount: 5 }, { fetchImpl: f as any, env })
    expect(out).toEqual({ kind: "completed", ref: "t1" })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe(`https://relay.test/send-status?clientReference=${REF}`)
    expect(init.method).toBe("GET")
  })
  it("checkSendStatus with an unreachable relay is unknown", async () => {
    expect((await checkSendStatus({ refundId: UUID, amount: 5 }, { fetchImpl: (async () => { throw new Error("x") }) as any, env })).kind).toBe("unknown")
  })
})

describe("readSendStatus (raw view + verdict for a stuck payout)", () => {
  const up = (upstreamStatus: number, body: unknown) => relay({ upstreamStatus, body })
  const withStatus = (transactionStatus: string) => up(200, { ResponseCode: "success", Data: { ClientReference: REF, transactionStatus, Amount: 5 } })

  it.each(["Success", "successful", "Paid", "Completed", "unsuccessful"])("%s reads as success: never markable", (w) => {
    expect(readSendStatus(withStatus(w), REF).verdict).toBe("success")
  })
  it.each(["failed", "Failed", "FAILED"])("%s reads as failed", (w) => {
    expect(readSendStatus(withStatus(w), REF).verdict).toBe("failed")
  })
  // A wrong "failed" lets an admin retry under a new reference, which can pay twice. Other words wait for the live test.
  it.each(["Declined", "Rejected", "reversed", "Cancelled", "expired", "failed to confirm", "pending", "processing", "queued", "something new", ""])("%j is not settled", (w) => {
    expect(readSendStatus(withStatus(w), REF).verdict).toBe("unclear")
  })
  it("only Hubtel's exact no-match answer is no_record (live probe 2026-11-05)", () => {
    const noMatch = { ResponseCode: "error", Data: "Your status check did not match any records, please check your request and try again." }
    expect(readSendStatus(up(400, noMatch), REF).verdict).toBe("no_record")
  })
  it.each([
    ["a 404 from a proxy or a wrong path", 404, { Message: "Not found" }],
    ["a 404 with the right words", 404, { ResponseCode: "error", Data: "did not match any records" }],
    ["a 400 saying the account was not found", 400, { ResponseCode: "error", Data: "Merchant account not found" }],
    ["a 400 with no record wording", 400, { ResponseCode: "error", Data: "no record" }],
    ["the words outside Data", 400, { message: "did not match any records" }],
    ["without Hubtel's response code", 400, { Data: "did not match any records" }],
  ])("%s is unclear, never no_record", (_n, status, body) => {
    expect(readSendStatus(up(status, body), REF).verdict).toBe("unclear")
  })
  it("another 4xx or 5xx, or a reply about another reference, is unclear", () => {
    expect(readSendStatus(up(401, { message: "unauthorized" }), REF).verdict).toBe("unclear")
    expect(readSendStatus(up(500, { message: "not found" }), REF).verdict).toBe("unclear")
    expect(readSendStatus(up(200, { Data: { ClientReference: "other", transactionStatus: "failed" } }), REF).verdict).toBe("unclear")
    expect(readSendStatus(up(200, {}), REF).verdict).toBe("unclear")
  })
  it("no answer at all is no_answer", () => {
    expect(readSendStatus({ kind: "not_configured" }, REF).verdict).toBe("no_answer")
    expect(readSendStatus({ kind: "transport_error", error: new Error("x") }, REF).verdict).toBe("no_answer")
    expect(readSendStatus(relay({ error: "bad" }, 502), REF).verdict).toBe("no_answer")
    expect(readSendStatus(up(0, null), REF).verdict).toBe("no_answer")
  })
  it("the raw view keeps the fields but never a phone number, as text or as a number", () => {
    const view = readSendStatus(up(200, { Data: { ClientReference: REF, transactionStatus: "pending", RecipientMsisdn: "233245550173", Number: 233245550174, Nested: [{ Note: "to 0245550175" }], Amount: 5 } }), REF)
    const text = JSON.stringify(view.raw)
    expect(text).not.toMatch(/245550173|245550174|245550175/)
    expect(text).toContain("transactionStatus")
    expect(text).toContain('"Amount":5')
  })
})
