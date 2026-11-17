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
  it("4xx non-JSON is unknown (conservative)", () => {
    expect(classifyOrderReply(403, "<html>blocked</html>").kind).toBe("unknown")
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
