import { describe, it, expect } from "vitest"
import {
  OUTCOME_UNKNOWN,
  UNKNOWN_TRACKING_PREFIX,
  classifyOrderReply,
  outcomeUnknownResponse,
  sendOrderRequest,
  isUnknownTrackingId,
} from "@/lib/mtn-providers/outcome"

const res = (status: number, body: string) => new Response(body, { status })

describe("classifyOrderReply", () => {
  it("non-JSON 2xx is unknown", () => {
    expect(classifyOrderReply(200, "<html>ok</html>").kind).toBe("unknown")
  })
  it("empty body is unknown", () => {
    expect(classifyOrderReply(200, "  ").kind).toBe("unknown")
  })
  it("500 HTML is unknown", () => {
    expect(classifyOrderReply(500, "<html>boom</html>").kind).toBe("unknown")
  })
  it("502 JSON with explicit rejection is an ordinary reply", () => {
    const r = classifyOrderReply(502, JSON.stringify({ success: false, message: "insufficient balance" }))
    expect(r.kind).toBe("json")
  })
  it("500 JSON with a generic server error message is unknown", () => {
    expect(classifyOrderReply(500, JSON.stringify({ success: false, message: "Internal Server Error" })).kind).toBe("unknown")
  })
  it("500 JSON without an explicit rejection is unknown", () => {
    expect(classifyOrderReply(500, JSON.stringify({ foo: 1 })).kind).toBe("unknown")
  })
  it("200 JSON explicit rejection is an ordinary reply", () => {
    expect(classifyOrderReply(200, JSON.stringify({ success: false, message: "not approved" })).kind).toBe("json")
  })
  it("200 JSON success is an ordinary reply", () => {
    const r = classifyOrderReply(200, JSON.stringify({ success: true, order_id: 1 }))
    expect(r.kind).toBe("json")
  })
  it("tolerates PHP warnings before the JSON", () => {
    const r = classifyOrderReply(200, 'Warning: x\n{"success":true,"order_id":5}')
    expect(r.kind).toBe("json")
  })
  it("non-JSON front-door statuses (401/403/404/405/429) never reached the provider app: ordinary", () => {
    for (const s of [401, 403, 404, 405, 429]) {
      expect(classifyOrderReply(s, "<html>blocked</html>").kind).toBe("not_reached")
    }
  })
  it("other non-JSON statuses stay unknown", () => {
    for (const s of [200, 201, 400, 500, 502, 504]) {
      expect(classifyOrderReply(s, "<html>x</html>").kind).toBe("unknown")
    }
  })
  it("5xx JSON needs a recognised rejection; cURL/SQLSTATE/exception text is unknown", () => {
    expect(classifyOrderReply(500, JSON.stringify({ success: false, message: "cURL error 28: timed out" })).kind).toBe("unknown")
    expect(classifyOrderReply(500, JSON.stringify({ success: false, message: "SQLSTATE[23000]: duplicate entry x" })).kind).toBe("unknown")
    expect(classifyOrderReply(500, JSON.stringify({ error: "Uncaught Exception in foo.php" })).kind).toBe("unknown")
    expect(classifyOrderReply(503, JSON.stringify({ success: false, message: "Out of stock" })).kind).toBe("json")
    expect(classifyOrderReply(500, JSON.stringify({ success: false, message: "Phone number does not match network" })).kind).toBe("json")
  })
})

describe("5xx rejections must match whole phrases", () => {
  const k = (msg: string) => classifyOrderReply(500, JSON.stringify({ success: false, message: msg })).kind
  it("post-acceptance errors that merely contain a keyword stay unknown", () => {
    expect(k("Invalid response from upstream")).toBe("unknown")
    expect(k("Invalid response from MTN gateway")).toBe("unknown")
    expect(k("Failed to update wallet balance")).toBe("unknown")
    expect(k("Resource not found in cache")).toBe("unknown")
    expect(k("Request blocked by proxy")).toBe("unknown")
  })
  it("real rejections are ordinary", () => {
    expect(k("Insufficient wallet balance")).toBe("json")
    expect(k("Invalid phone number")).toBe("json")
    expect(k("0551234567 is not approved for MTN purchases")).toBe("json")
    expect(k("Duplicate reference")).toBe("json")
    expect(k("Package out of stock")).toBe("json")
    expect(k("Network service is disabled")).toBe("json")
  })
})

describe("send errors", () => {
  const withCode = (code: string, viaCause = true) => {
    const e: any = new Error("fetch failed")
    if (viaCause) e.cause = { code }
    else e.code = code
    return e
  }
  it("connection-never-made codes are ordinary NETWORK_ERROR failures", async () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
      const r = await sendOrderRequest("X", async () => { throw withCode(code) })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.response.error_type, code).toBe("NETWORK_ERROR")
    }
    const r = await sendOrderRequest("X", async () => { throw withCode("ENOTFOUND", false) })
    if (!r.ok) expect(r.response.error_type).toBe("NETWORK_ERROR")
  })
  it("reset/socket/timeout/abort errors stay unknown", async () => {
    for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
      const r = await sendOrderRequest("X", async () => { throw withCode(code) })
      if (!r.ok) expect(r.response.error_type, code).toBe("OUTCOME_UNKNOWN")
    }
    const abort = new Error("aborted"); abort.name = "AbortError"
    const r = await sendOrderRequest("X", async () => { throw abort })
    if (!r.ok) expect(r.response.error_type).toBe("OUTCOME_UNKNOWN")
  })
  it("a non-JSON 403 through sendOrderRequest is an ordinary failure", async () => {
    const r = await sendOrderRequest("X", async () => res(403, "<html>waf</html>"))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.error_type).toBe("API_ERROR")
  })
})

describe("outcomeUnknownResponse", () => {
  it("carries the type and the dashboard message", () => {
    const r = outcomeUnknownResponse("Apex Prime", 500)
    expect(r.success).toBe(false)
    expect(r.error_type).toBe(OUTCOME_UNKNOWN)
    expect(r.message).toBe(
      "Apex Prime returned an unreadable response (HTTP 500) — the order may have been created. Check the Apex Prime dashboard before retrying."
    )
  })
  it("uses 'no response' wording for thrown errors", () => {
    const r = outcomeUnknownResponse("Apex Prime", null)
    expect(r.message).toContain("returned no response")
    expect(r.message).toContain("Check the Apex Prime dashboard before retrying.")
  })
})

describe("sendOrderRequest", () => {
  it("returns unknown when the fetch throws after being issued", async () => {
    const r = await sendOrderRequest("Sykes", async () => { throw new Error("timeout") })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.error_type).toBe(OUTCOME_UNKNOWN)
  })
  it("returns unknown for HTML 500", async () => {
    const r = await sendOrderRequest("Sykes", async () => res(500, "<html/>"))
    expect(r.ok).toBe(false)
  })
  it("returns parsed json for success", async () => {
    const r = await sendOrderRequest("Sykes", async () => res(200, '{"success":true,"order_id":9}'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.json.order_id).toBe(9)
  })
  it("returns parsed json for a 502 explicit rejection", async () => {
    const r = await sendOrderRequest("Sykes", async () => res(502, '{"success":false,"message":"insufficient balance"}'))
    expect(r.ok).toBe(true)
  })
})

describe("unknown tracking ids", () => {
  it("recognises the prefix", () => {
    expect(UNKNOWN_TRACKING_PREFIX).toBe("UNKNOWN_")
    expect(isUnknownTrackingId("UNKNOWN_123")).toBe(true)
    expect(isUnknownTrackingId("FAILED_INIT_1")).toBe(false)
  })
})
