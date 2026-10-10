import { describe, it, expect, vi } from "vitest"
import {
  classifyHubtelResponse, mapHubtelStatus, toHubtelMsisdn, hubtelSendSingle, hubtelSendBatchSimple,
  hubtelSendBatchPersonalized, hubtelGetBatchStatus, hubtelGetMessageStatus, isValidHubtelMsisdn, hubtelConfigFromEnv, type HubtelConfig,
} from "./hubtel"

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }))
}
const cfg = (f: ReturnType<typeof fakeFetch>): HubtelConfig => ({ clientId: "id", clientSecret: "secret", fetchImpl: f as unknown as typeof fetch })

describe("toHubtelMsisdn", () => {
  it("normalises Ghana numbers", () => {
    expect(toHubtelMsisdn("+233241234567")).toBe("233241234567")
    expect(toHubtelMsisdn("0241234567")).toBe("233241234567")
    expect(toHubtelMsisdn("233241234567")).toBe("233241234567")
  })
})

describe("classifyHubtelResponse", () => {
  it("2xx + status 0 → accepted", () => expect(classifyHubtelResponse(201, { status: 0 }).outcome).toBe("accepted"))
  it("201 + status 1/2/100 → rejected (the 201 trap)", () => {
    for (const s of [1, 2, 100]) expect(classifyHubtelResponse(201, { status: s }).outcome).toBe("rejected")
  })
  it("2xx without a status or ids → unknown (never assume success or failure)", () => expect(classifyHubtelResponse(200, {}).outcome).toBe("unknown"))
  it("402 or status 12 → out_of_funds", () => {
    expect(classifyHubtelResponse(402, {}).outcome).toBe("out_of_funds")
    expect(classifyHubtelResponse(400, { status: 12 }).outcome).toBe("out_of_funds")
  })
  it("400 → rejected; 401/5xx → retryable", () => {
    expect(classifyHubtelResponse(400, { status: 4 }).outcome).toBe("rejected")
    expect(classifyHubtelResponse(401, {}).outcome).toBe("retryable")
    expect(classifyHubtelResponse(503, {}).outcome).toBe("retryable")
  })
})

describe("mapHubtelStatus", () => {
  it("maps DLR statuses", () => {
    expect(mapHubtelStatus("Delivered")).toBe("delivered")
    expect(mapHubtelStatus("Sent")).toBe("pending")
    expect(mapHubtelStatus("Pending")).toBe("pending")
    expect(mapHubtelStatus("")).toBe("pending")
    for (const s of ["Blacklisted", "Undeliverable/Failed", "Rejected", "NACK/0x0000000b/Invalid Destination Address"]) {
      expect(mapHubtelStatus(s)).toBe("failed")
    }
  })
})

describe("senders", () => {
  it("single: posts From/To/Content with Basic auth and returns messageId + rate", async () => {
    const f = fakeFetch(201, { rate: 0.0246, messageId: "m1", status: 0 })
    const r = await hubtelSendSingle(cfg(f), { from: "KINGS", to: "+233241234567", content: "hi" })
    expect(r).toMatchObject({ outcome: "accepted", messageId: "m1", rate: 0.0246 })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://sms.hubtel.com/v1/messages/send")
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`)
    expect(JSON.parse(String(init.body))).toEqual({ From: "KINGS", To: "233241234567", Content: "hi" })
  })
  it("batch simple: returns batchId and recipient→messageId", async () => {
    const f = fakeFetch(200, { batchId: "b1", status: 0, data: [{ recipient: "233241234567", content: "x", messageId: "m1" }] })
    const r = await hubtelSendBatchSimple(cfg(f), { from: "KINGS", recipients: ["+233241234567"], content: "x" })
    expect(r).toMatchObject({ outcome: "accepted", batchId: "b1", messages: [{ recipient: "233241234567", messageId: "m1" }] })
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ From: "KINGS", Recipients: ["233241234567"], Content: "x" })
  })
  it("batch personalized: sends personalizedRecipients", async () => {
    const f = fakeFetch(200, { batchId: "b2", status: 0, data: [] })
    await hubtelSendBatchPersonalized(cfg(f), { from: "KINGS", items: [{ to: "0241234567", content: "Hi A" }] })
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ From: "KINGS", personalizedRecipients: [{ To: "233241234567", Content: "Hi A" }] })
  })
  it("ambiguous network error → unknown and never leaks the secret", async () => {
    const f = vi.fn(async () => { throw new Error("boom secret") })
    const r = await hubtelSendSingle({ clientId: "a", clientSecret: "secret", fetchImpl: f as unknown as typeof fetch }, { from: "X", to: "0241234567", content: "y" })
    expect(r.outcome).toBe("unknown")
    expect(r.error ?? "").not.toContain("secret")
  })
})

describe("failure modes", () => {
  const send = (f: unknown) => hubtelSendSingle({ clientId: "a", clientSecret: "b", fetchImpl: f as typeof fetch }, { from: "X", to: "0241234567", content: "y" })
  it("TimeoutError → unknown", async () => {
    const e = new Error("t"); e.name = "TimeoutError"
    expect((await send(vi.fn(async () => { throw e }))).outcome).toBe("unknown")
  })
  it("ECONNREFUSED cause → retryable", async () => {
    const e = new Error("fetch failed", { cause: { code: "ECONNREFUSED" } })
    expect((await send(vi.fn(async () => { throw e }))).outcome).toBe("retryable")
  })
  it("ECONNRESET cause → unknown", async () => {
    const e = new Error("fetch failed", { cause: { code: "ECONNRESET" } })
    expect((await send(vi.fn(async () => { throw e }))).outcome).toBe("unknown")
  })
  it("201 with unreadable body → unknown", async () => {
    const res = { status: 201, text: async () => { throw new Error("reset") } }
    expect((await send(vi.fn(async () => res))).outcome).toBe("unknown")
  })
  it("200 HTML body → unknown", async () => expect((await send(fakeFetch(200, "<html>oops</html>"))).outcome).toBe("unknown"))
  it('200 {status:"0", batchId} → accepted', async () => expect((await send(fakeFetch(200, { status: "0", batchId: "b" }))).outcome).toBe("accepted"))
  it("200 {messageId} without status → accepted", async () => expect((await send(fakeFetch(200, { messageId: "m" }))).outcome).toBe("accepted"))
  it("429 → retryable, 502 → unknown, 403 → rejected", async () => {
    expect((await send(fakeFetch(429, {}))).outcome).toBe("retryable")
    expect((await send(fakeFetch(502, {}))).outcome).toBe("unknown")
    expect((await send(fakeFetch(403, {}))).outcome).toBe("rejected")
  })
  it("status GET reports ok:false on network failure", async () => {
    const f = vi.fn(async () => { throw new Error("x") })
    expect((await hubtelGetBatchStatus({ clientId: "a", clientSecret: "b", fetchImpl: f as unknown as typeof fetch }, "b1")).ok).toBe(false)
  })
})

describe("msisdn + config + status extras", () => {
  it("normalises messy numbers", () => {
    expect(toHubtelMsisdn("+233 (0)24 123 4567")).toBe("233241234567")
    expect(toHubtelMsisdn("00233241234567")).toBe("233241234567")
    expect(toHubtelMsisdn("2330241234567")).toBe("233241234567")
    expect(toHubtelMsisdn("241234567")).toBe("233241234567")
  })
  it("isValidHubtelMsisdn", () => {
    expect(isValidHubtelMsisdn("233241234567")).toBe(true)
    expect(isValidHubtelMsisdn("")).toBe(false)
    expect(isValidHubtelMsisdn("23324123")).toBe(false)
  })
  it("unknown new statuses stay pending", () => {
    expect(mapHubtelStatus("Queued")).toBe("pending")
    expect(mapHubtelStatus("Message Failed")).toBe("failed")
  })
  it("hubtelConfigFromEnv is null without creds", () => {
    const a = process.env.HUBTEL_SMS_CLIENT_ID, b = process.env.HUBTEL_SMS_CLIENT_SECRET
    delete process.env.HUBTEL_SMS_CLIENT_ID; delete process.env.HUBTEL_SMS_CLIENT_SECRET
    expect(hubtelConfigFromEnv()).toBeNull()
    if (a) process.env.HUBTEL_SMS_CLIENT_ID = a
    if (b) process.env.HUBTEL_SMS_CLIENT_SECRET = b
  })
})

describe("status checks", () => {
  it("batch status maps each message", async () => {
    const f = fakeFetch(200, { batchId: "b1", data: [
      { rate: 0.0309, messageId: "m1", status: "Delivered", updateTime: "2026-10-10T10:00:00" },
      { rate: 0.0309, messageId: "m2", status: "Rejected" },
      { messageId: "m3", status: "Sent" },
    ] })
    const r = await hubtelGetBatchStatus(cfg(f), "b1")
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://sms.hubtel.com/v1/messages/batch/b1")
    expect(r.ok).toBe(true)
    expect(r.messages.map((m) => [m.messageId, m.state, m.rate])).toEqual([["m1", "delivered", 0.0309], ["m2", "failed", 0.0309], ["m3", "pending", undefined]])
  })
  it("non-2xx batch status → ok:false", async () => {
    expect((await hubtelGetBatchStatus(cfg(fakeFetch(404, {})), "x")).ok).toBe(false)
  })
  it("single message status", async () => {
    const r = await hubtelGetMessageStatus(cfg(fakeFetch(200, { rate: 0.03, messageId: "m9", status: "Delivered" })), "m9")
    expect(r).toMatchObject({ ok: true, messages: [{ messageId: "m9", state: "delivered", rate: 0.03 }] })
  })
})
