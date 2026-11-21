import { describe, it, expect } from "vitest"
import {
  hubnetRef,
  parseHubnetRef,
  endpointFor,
  toHubnetPhone,
  mapHubnetStatus,
  isHubnetRefunded,
  classifyStatusReply,
  classifyPlaceReply,
  normalizeRefunds,
  HUBNET_MAX_ATTEMPTS,
} from "./core"

const UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const HEX22 = "0a1b2c3d4e5f4a6b8c7d9e"

describe("hubnetRef", () => {
  it("builds attempt 1 as DG + 22 hex (24 chars)", () => {
    const r = hubnetRef("data", UUID, 1)
    expect(r).toBe(`DG${HEX22}`)
    expect(r).toHaveLength(24)
  })
  it("appends R<n> for retries", () => {
    const r = hubnetRef("data", UUID, 3)
    expect(r.endsWith("R3")).toBe(true)
    expect(r).toHaveLength(26)
  })
  it("uses DA for airtime and is deterministic", () => {
    expect(hubnetRef("airtime", UUID, 1).startsWith("DA")).toBe(true)
    expect(hubnetRef("data", UUID, 2)).toBe(hubnetRef("data", UUID, 2))
  })
  it("throws on bad attempt or uuid", () => {
    expect(() => hubnetRef("data", UUID, 6)).toThrow()
    expect(() => hubnetRef("data", UUID, 0)).toThrow()
    expect(() => hubnetRef("data", "not-a-uuid", 1)).toThrow()
    expect(HUBNET_MAX_ATTEMPTS).toBe(5)
  })
  it("always matches the shape and stays under 30 chars", () => {
    for (const kind of ["data", "airtime"] as const) {
      for (let a = 1; a <= 5; a++) {
        const r = hubnetRef(kind, UUID, a)
        expect(r).toMatch(/^D[GA][0-9a-f]{22}(R[2-5])?$/)
        expect(r.length).toBeLessThan(30)
      }
    }
  })
})

describe("parseHubnetRef", () => {
  it("round-trips", () => {
    expect(parseHubnetRef(hubnetRef("data", UUID, 1))).toEqual({ kind: "data", prefix22: HEX22, attempt: 1 })
    expect(parseHubnetRef(hubnetRef("airtime", UUID, 4))).toEqual({ kind: "airtime", prefix22: HEX22, attempt: 4 })
  })
  it("returns null for foreign refs", () => {
    expect(parseHubnetRef("UNKNOWN_123")).toBeNull()
    expect(parseHubnetRef("DGxyz")).toBeNull()
  })
})

describe("endpointFor routing", () => {
  it("maps networks", () => {
    expect(endpointFor("MTN")).toBe("mtn")
    expect(endpointFor("AirtelTigo")).toBe("at")
    expect(endpointFor("AirtelTigo", true)).toBe("big-time")
    expect(endpointFor("Telecel")).toBe("telecel")
  })
})

describe("toHubnetPhone", () => {
  it("normalises to local format", () => {
    expect(toHubnetPhone("+233241234567")).toBe("0241234567")
    expect(toHubnetPhone("0241234567")).toBe("0241234567")
    expect(toHubnetPhone("12345")).toBeNull()
  })
})

describe("mapHubnetStatus", () => {
  it("maps vocabulary case-insensitively", () => {
    for (const w of ["success", "Completed", "DELIVERED"]) expect(mapHubnetStatus(w)).toBe("completed")
    for (const w of ["failed", "Refunded", "reversed", "cancelled"]) expect(mapHubnetStatus(w)).toBe("failed")
    for (const w of ["pending", "processing", "queued", "initiated"]) expect(mapHubnetStatus(w)).toBe("processing")
    expect(mapHubnetStatus(undefined)).toBe("processing")
    expect(mapHubnetStatus("weird")).toBe("processing")
  })
})

describe("isHubnetRefunded", () => {
  it("detects status words and boolean flag", () => {
    expect(isHubnetRefunded({ status: true, data: { status: "refunded" } })).toBe(true)
    expect(isHubnetRefunded({ delivery_status: "Reversed" })).toBe(true)
    expect(isHubnetRefunded({ refunded: true })).toBe(true)
    expect(isHubnetRefunded({ data: { delivery_status: "delivered" } })).toBe(false)
    expect(isHubnetRefunded(null)).toBe(false)
    expect(isHubnetRefunded("x")).toBe(false)
  })
})

describe("classifyStatusReply", () => {
  it("treats bare 404 as unknown", () => {
    expect(classifyStatusReply(404, { success: false, message: "Not Found" })).toEqual({ kind: "unknown" })
  })
  it("treats a transaction-not-found 404 as missing", () => {
    expect(classifyStatusReply(404, { success: false, message: "Transaction not found" })).toEqual({ kind: "missing" })
  })
  it("treats 5xx and non-objects as unknown", () => {
    expect(classifyStatusReply(500, { message: "boom" })).toEqual({ kind: "unknown" })
    expect(classifyStatusReply(200, "html")).toEqual({ kind: "unknown" })
    expect(classifyStatusReply(200, null)).toEqual({ kind: "unknown" })
  })
  it("parses nested found body", () => {
    const body = { status: true, data: { delivery_status: "delivered", amount: 4.5 } }
    expect(classifyStatusReply(200, body)).toEqual({
      kind: "found", status: "completed", refunded: false, raw: body, costGhs: 4.5,
    })
  })
  it("parses top-level status and flags refunds", () => {
    const body = { success: true, status: "refunded" }
    const r = classifyStatusReply(200, body)
    expect(r).toMatchObject({ kind: "found", status: "failed", refunded: true })
    expect((r as { costGhs?: number }).costGhs).toBeUndefined()
  })
  it("prefers the nested data status over an API-level top-level word", () => {
    const body = { status: "success", data: { delivery_status: "pending" } }
    expect(classifyStatusReply(200, body)).toMatchObject({ kind: "found", status: "processing", refunded: false })
  })
  it("refund signal anywhere wins", () => {
    expect(classifyStatusReply(200, { status: "completed", data: { status: "refunded" } })).toMatchObject({
      kind: "found", status: "failed", refunded: true,
    })
  })
  it("ignores a boolean top-level status and reads data", () => {
    expect(classifyStatusReply(200, { status: true, data: { transaction_status: "queued" } })).toMatchObject({
      kind: "found", status: "processing",
    })
  })
  it("treats other missing-transaction 404 wordings as missing", () => {
    expect(classifyStatusReply(404, { message: "No transaction for reference" })).toEqual({ kind: "missing" })
    expect(classifyStatusReply(404, { message: "Invalid reference" })).toEqual({ kind: "missing" })
  })
  it("treats 404 with non-object body as unknown", () => {
    expect(classifyStatusReply(404, "Not Found")).toEqual({ kind: "unknown" })
  })
  // Live probe 2026-11-21: check-transaction-status?reference=<unknown ref> answers exactly this.
  // (A missing ?reference= gives 400; a wrong path segment gives 404 "Page not found.")
  it("treats Hubnet's live 'Invalid path' not-found reply as missing", () => {
    const live = {
      event: "query.success",
      ip: "172.68.42.128",
      message: "Invalid path. Please provide a valid path: check_balance, check-transaction-status, refunds, or mtn-verification.",
      status: false,
      request_id: "c6490340-2507044",
      data: null,
    }
    expect(classifyStatusReply(404, live)).toEqual({ kind: "missing" })
  })
  it("keeps a router-level 'Page not found.' 404 as unknown", () => {
    expect(classifyStatusReply(404, { success: false, message: "Page not found." })).toEqual({ kind: "unknown" })
  })
  it("keeps an 'Invalid path' 404 that carries data as unknown", () => {
    expect(classifyStatusReply(404, { event: "query.success", message: "Invalid path.", status: false, data: { x: 1 } })).toEqual({ kind: "unknown" })
  })
  it("unknown when 200 has no status word", () => {
    expect(classifyStatusReply(200, { success: true })).toEqual({ kind: "unknown" })
  })
})

describe("classifyPlaceReply", () => {
  it("classifies", () => {
    expect(classifyPlaceReply(200, { event: "charge.success" })).toBe("success")
    expect(classifyPlaceReply(409, { success: false })).toBe("duplicate")
    expect(classifyPlaceReply(400, { status_code: 402 })).toBe("insufficient_balance")
    expect(classifyPlaceReply(400, { message: "Insufficient balance" })).toBe("insufficient_balance")
    expect(classifyPlaceReply(401, {})).toBe("auth")
    expect(classifyPlaceReply(429, {})).toBe("rate_limited")
    expect(classifyPlaceReply(400, { message: "bad phone" })).toBe("rejected")
    expect(classifyPlaceReply(403, { message: "disabled" })).toBe("rejected")
    expect(classifyPlaceReply(503, {})).toBe("unknown")
    expect(classifyPlaceReply(200, "html")).toBe("unknown")
    expect(classifyPlaceReply(400, null)).toBe("unknown")
  })
})

describe("normalizeRefunds", () => {
  it("accepts array at top level, data, or data.refunds", () => {
    const item = { reference: "DGabc", phone: "0241234567", volume: "1000", amount: "4.5", created_at: "2026-11-21" }
    const expected = [{ reference: "DGabc", phone: "0241234567", volume: "1000", amount: 4.5, date: "2026-11-21" }]
    expect(normalizeRefunds([item])).toEqual(expected)
    expect(normalizeRefunds({ data: [item] })).toEqual(expected)
    expect(normalizeRefunds({ data: { refunds: [item] } })).toEqual(expected)
  })
  it("reads alternate keys", () => {
    expect(normalizeRefunds([{ batch_id: "B1", number: "0241234567", date: "d" }])).toEqual([
      { reference: "B1", phone: "0241234567", date: "d" },
    ])
  })
  it("returns [] for garbage", () => {
    expect(normalizeRefunds(null)).toEqual([])
    expect(normalizeRefunds("x")).toEqual([])
    expect(normalizeRefunds({ data: 5 })).toEqual([])
    expect(normalizeRefunds([1, null, "a"])).toEqual([])
  })
})

describe("classifyStatusReply envelope status (I3)", () => {
  it("envelope success with unrecognised nested key is unknown", () => {
    expect(classifyStatusReply(200, { status: "success", data: { deliveryStatus: "pending" } })).toEqual({ kind: "unknown" })
  })
  it("envelope success with null data is unknown", () => {
    expect(classifyStatusReply(200, { status: "success", data: null })).toEqual({ kind: "unknown" })
  })
  it("envelope success alone is unknown", () => {
    expect(classifyStatusReply(200, { status: "success" })).toEqual({ kind: "unknown" })
  })
  it("nested data.status success is completed", () => {
    expect(classifyStatusReply(200, { data: { status: "success" } })).toMatchObject({ kind: "found", status: "completed" })
  })
  it("top-level delivery_status delivered is completed", () => {
    expect(classifyStatusReply(200, { delivery_status: "delivered" })).toMatchObject({ kind: "found", status: "completed" })
  })
})
