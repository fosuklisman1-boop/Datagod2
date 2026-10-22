import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildCallbackUrl, classifyRefundReply, requestHubtelRefund, signCallbackToken, verifyCallbackToken,
} from "./hubtel-refund"

beforeEach(() => {
  vi.stubEnv("HUBTEL_RELAY_URL", "https://relay.example.com/")
  vi.stubEnv("HUBTEL_RELAY_SECRET", "relay-secret")
  vi.stubEnv("HUBTEL_REFUND_CALLBACK_SECRET", "cb-secret")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com")
})
afterEach(() => vi.unstubAllEnvs())

describe("classifyRefundReply", () => {
  it("0001 is pending with Hubtel's orderId", () => {
    expect(classifyRefundReply(202, { responseCode: "0001", data: { orderId: "X" } })).toEqual({ kind: "pending", ref: "X" })
  })
  it("does not throw when data is a non-object truthy value", () => {
    expect(classifyRefundReply(202, { responseCode: "0001", data: "oops" })).toEqual({ kind: "pending", ref: "" })
  })
  it("4515 (already in progress) is pending, empty ref when no data", () => {
    expect(classifyRefundReply(423, { responseCode: "4515", data: null })).toEqual({ kind: "pending", ref: "" })
  })
  it.each(["3000", "4000"])("404 %s is failed with Hubtel's message", (code) => {
    expect(classifyRefundReply(404, { responseCode: code, message: "nope" })).toEqual({ kind: "failed", error: "nope" })
  })
  it("4509 is failed and warns that Hubtel may already have refunded it", () => {
    expect(classifyRefundReply(404, { responseCode: "4509", message: "nope" })).toEqual({
      kind: "failed",
      error: "Hubtel 4509: not eligible — it may already have been refunded by Hubtel; check Hubtel before refunding another way. nope",
    })
  })
  it("a failed code without a message still carries an error", () => {
    const r = classifyRefundReply(404, { responseCode: "3000" })
    expect(r.kind).toBe("failed")
  })
  it("5xx html is unknown", () => {
    expect(classifyRefundReply(500, "<html>").kind).toBe("unknown")
  })
  it("network error (status 0) is unknown", () => {
    expect(classifyRefundReply(0, "timeout").kind).toBe("unknown")
  })
  it("404 with a non-JSON body is unknown", () => {
    expect(classifyRefundReply(404, "Not Found").kind).toBe("unknown")
  })
  it("404 with an unrecognised responseCode is unknown", () => {
    expect(classifyRefundReply(404, { responseCode: "9999", message: "x" }).kind).toBe("unknown")
  })

  const HTML_403 = "<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center></body></html>"
  const frontDoor = (status: number) =>
    `Hubtel refused the refund request (HTTP ${status}) — the relay's IP is probably not whitelisted for the refund API, or the credential was rejected. Nothing was processed.`
  it("upstream 403 with an HTML body is failed with the fixed message and no markup", () => {
    const r = classifyRefundReply(403, HTML_403)
    expect(r).toEqual({ kind: "failed", error: frontDoor(403) })
    expect((r as any).error).not.toContain("<html")
  })
  it("upstream 401 with an HTML body is failed", () => {
    expect(classifyRefundReply(401, "<html>401 Unauthorized</html>")).toEqual({ kind: "failed", error: frontDoor(401) })
  })
  it("upstream 403 with a JSON body carrying 4509 keeps the 4509 mapping", () => {
    expect(classifyRefundReply(403, { responseCode: "4509", message: "nope" })).toEqual({
      kind: "failed",
      error: "Hubtel 4509: not eligible — it may already have been refunded by Hubtel; check Hubtel before refunding another way. nope",
    })
  })
  it("upstream 403 with a JSON body carrying 0001 stays pending", () => {
    expect(classifyRefundReply(403, { responseCode: "0001", data: { orderId: "X" } })).toEqual({ kind: "pending", ref: "X" })
  })
  it("upstream 500 with an HTML body stays unknown", () => {
    expect(classifyRefundReply(500, HTML_403).kind).toBe("unknown")
  })
  it("upstream 0 (timeout) stays unknown", () => {
    expect(classifyRefundReply(0, "timeout").kind).toBe("unknown")
  })
  it("upstream 302 with an empty body stays unknown", () => {
    expect(classifyRefundReply(302, "").kind).toBe("unknown")
  })
})

describe("callback token", () => {
  it("round trips", () => {
    expect(verifyCallbackToken("r1", signCallbackToken("r1"))).toBe(true)
  })
  it("rejects a wrong token", () => {
    expect(verifyCallbackToken("r1", "0".repeat(64))).toBe(false)
  })
  it("rejects a token minted for another refund", () => {
    expect(verifyCallbackToken("r2", signCallbackToken("r1"))).toBe(false)
  })
  it("rejects a different-length token without throwing", () => {
    expect(verifyCallbackToken("r1", "abc")).toBe(false)
    expect(verifyCallbackToken("r1", "")).toBe(false)
  })
  it("empty secret: verify false, sign throws", () => {
    const token = signCallbackToken("r1")
    vi.stubEnv("HUBTEL_REFUND_CALLBACK_SECRET", "")
    expect(verifyCallbackToken("r1", token)).toBe(false)
    expect(() => signCallbackToken("r1")).toThrow()
  })
})

describe("buildCallbackUrl", () => {
  it("builds the webhook url with refund id and token", () => {
    const url = new URL(buildCallbackUrl("r1"))
    expect(url.origin + url.pathname).toBe("https://app.example.com/api/webhooks/hubtel-refund")
    expect(url.searchParams.get("refund")).toBe("r1")
    expect(verifyCallbackToken("r1", url.searchParams.get("t") ?? "")).toBe(true)
  })
  it("percent-encodes the token and refund id in the query", () => {
    const url = buildCallbackUrl("a b&c")
    expect(url).toContain("refund=a%20b%26c")
    expect(url).toContain(`t=${encodeURIComponent(signCallbackToken("a b&c"))}`)
  })
  it("throws when NEXT_PUBLIC_APP_URL is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    expect(() => buildCallbackUrl("r1")).toThrow()
  })
  it("throws when the callback secret is missing", () => {
    vi.stubEnv("HUBTEL_REFUND_CALLBACK_SECRET", "")
    expect(() => buildCallbackUrl("r1")).toThrow()
  })
})

const relayReply = (status: number, json: unknown) =>
  vi.fn(async () => new Response(typeof json === "string" ? json : JSON.stringify(json), { status })) as unknown as typeof fetch

describe("requestHubtelRefund", () => {
  it("posts orderId and callbackUrl to the relay with bearer auth", async () => {
    const f = relayReply(200, { ok: true, upstreamStatus: 202, body: { responseCode: "0001", data: { orderId: "H1" } } })
    await requestHubtelRefund("H1", "r1", f)
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe("https://relay.example.com/refund")
    expect(init.headers.Authorization).toBe("Bearer relay-secret")
    const sent = JSON.parse(init.body)
    expect(sent.orderId).toBe("H1")
    expect(sent.callbackUrl).toContain("refund=r1")
  })
  it("maps an accepted refund to pending", async () => {
    const f = relayReply(200, { ok: true, upstreamStatus: 202, body: { responseCode: "0001", data: { orderId: "H1" } } })
    expect(await requestHubtelRefund("H1", "r1", f)).toEqual({ kind: "pending", ref: "H1" })
  })
  it("overrides ref with the hubtelOrderId argument for 4515 (null data)", async () => {
    const f = relayReply(200, { ok: false, upstreamStatus: 423, body: { responseCode: "4515", data: null } })
    expect(await requestHubtelRefund("H1", "r1", f)).toEqual({ kind: "pending", ref: "H1" })
  })
  it("overrides ref even when Hubtel returns a different orderId", async () => {
    const f = relayReply(200, { ok: true, upstreamStatus: 202, body: { responseCode: "0001", data: { orderId: "OTHER" } } })
    expect(await requestHubtelRefund("H1", "r1", f)).toEqual({ kind: "pending", ref: "H1" })
  })
  it("maps a Hubtel rejection relayed with ok:false to failed", async () => {
    const f = relayReply(200, { ok: false, upstreamStatus: 404, body: { responseCode: "4000", message: "bad order" } })
    expect(await requestHubtelRefund("H1", "r1", f)).toEqual({ kind: "failed", error: "bad order" })
  })
  it("relay 404 (route missing) is failed with the update message", async () => {
    const f = relayReply(404, { error: "not found" })
    expect(await requestHubtelRefund("H1", "r1", f)).toEqual({
      kind: "failed", error: "Hubtel relay has not been updated to support refunds",
    })
  })
  it("relay 400 (request never reached Hubtel) is failed", async () => {
    const f = relayReply(400, { error: "bad request" })
    expect(await requestHubtelRefund("H1", "r1", f)).toEqual({
      kind: "failed", error: "Hubtel relay rejected the request (invalid order id or callback URL)",
    })
  })
  it.each([401, 403])("relay %i (auth) is failed", async (status) => {
    const f = relayReply(status, { error: "unauthorized" })
    expect(await requestHubtelRefund("H1", "r1", f)).toEqual({
      kind: "failed", error: "Hubtel relay authentication failed — check HUBTEL_RELAY_SECRET",
    })
  })
  it("Hubtel front-door 403 (relay IP not whitelisted) is failed, called once, no markup", async () => {
    const f = relayReply(200, {
      ok: false, upstreamStatus: 403,
      body: "<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>",
    })
    const r = await requestHubtelRefund("H1", "r1", f)
    expect(r).toEqual({
      kind: "failed",
      error: "Hubtel refused the refund request (HTTP 403) — the relay's IP is probably not whitelisted for the refund API, or the credential was rejected. Nothing was processed.",
    })
    expect((r as any).error).not.toContain("<html")
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("relay unreachable is unknown", async () => {
    const f = vi.fn(async () => { throw new Error("boom") }) as unknown as typeof fetch
    expect((await requestHubtelRefund("H1", "r1", f)).kind).toBe("unknown")
  })
  it("relay non-200 is unknown", async () => {
    expect((await requestHubtelRefund("H1", "r1", relayReply(502, "bad gateway"))).kind).toBe("unknown")
  })
  it("relay-reported network error (upstreamStatus 0) is unknown", async () => {
    const f = relayReply(200, { ok: false, upstreamStatus: 0, body: "timeout" })
    expect((await requestHubtelRefund("H1", "r1", f)).kind).toBe("unknown")
  })
  it("relay not configured is failed and sends nothing", async () => {
    vi.stubEnv("HUBTEL_RELAY_URL", "")
    const f = relayReply(200, {})
    expect(await requestHubtelRefund("H1", "r1", f)).toEqual({ kind: "failed", error: "relay not configured" })
    expect(f).not.toHaveBeenCalled()
  })
  it("missing callback config is failed and sends nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    const f = relayReply(200, {})
    expect((await requestHubtelRefund("H1", "r1", f)).kind).toBe("failed")
    expect(f).not.toHaveBeenCalled()
  })
})
