import {
  mapItemStatus,
  buildQueuePayload,
  deriveOrderStatus,
} from "@/lib/mtn-providers/agentportalgh-provider"

describe("mapItemStatus", () => {
  it("maps 'success' to completed", () => expect(mapItemStatus("success")).toBe("completed"))
  it("maps 'failed' to failed", () => expect(mapItemStatus("failed")).toBe("failed"))
  it("maps 'pending' to pending", () => expect(mapItemStatus("pending")).toBe("pending"))
  it("maps unknown to processing", () => expect(mapItemStatus("queued")).toBe("processing"))
  it("maps empty string to processing", () => expect(mapItemStatus("")).toBe("processing"))
  it("is case-insensitive", () => {
    expect(mapItemStatus("SUCCESS")).toBe("completed")
    expect(mapItemStatus("FAILED")).toBe("failed")
    expect(mapItemStatus("Pending")).toBe("pending")
  })
})

describe("buildQueuePayload", () => {
  it("rounds fractional GB to integer", () => {
    const body = buildQueuePayload("0241234567", 1.7, "ref-uuid")
    expect(body.items[0].data_gb).toBe(2)
  })
  it("always sets service to mtn", () => {
    const body = buildQueuePayload("0241234567", 3, "ref-uuid")
    expect(body.service).toBe("mtn")
  })
  it("passes the reference through unchanged", () => {
    const body = buildQueuePayload("0241234567", 5, "my-uuid-123")
    expect(body.items[0].reference).toBe("my-uuid-123")
  })
  it("passes the msisdn through unchanged", () => {
    const body = buildQueuePayload("0241234567", 5, "r")
    expect(body.items[0].msisdn).toBe("0241234567")
  })
})

describe("deriveOrderStatus", () => {
  it("returns null when no count fields are present (caller should try another source)", () => {
    expect(deriveOrderStatus({ processing_status: "DONE" })).toBeNull()
  })
  it("returns completed when success_count > 0 and failure_count is 0", () => {
    expect(deriveOrderStatus({ success_count: 1, failure_count: 0 })).toBe("completed")
  })
  it("returns failed when failure_count > 0 and success_count is 0", () => {
    expect(deriveOrderStatus({ success_count: 0, failure_count: 1 })).toBe("failed")
  })
  it("uses processing_status DONE + failure_count to break a mixed/zero count tie", () => {
    expect(deriveOrderStatus({ success_count: 0, failure_count: 0, processing_status: "DONE" })).toBe("completed")
    expect(deriveOrderStatus({ success_count: 0, failure_count: 2, processing_status: "DONE" })).toBe("failed")
  })
  it("returns processing when neither terminal condition nor DONE applies", () => {
    expect(deriveOrderStatus({ success_count: 0, failure_count: 0, processing_status: "IN_PROGRESS" })).toBe("processing")
  })
  it("falls back to legacy 'status' field if processing_status is absent", () => {
    expect(deriveOrderStatus({ success_count: 0, failure_count: 0, status: "DONE" })).toBe("completed")
  })
})
