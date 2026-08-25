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
    const body = buildQueuePayload("0241234567", 1.7, "ref-uuid", "MTN")
    expect(body.items[0].data_gb).toBe(2)
  })
  it("sets service to mtn for the MTN network", () => {
    const body = buildQueuePayload("0241234567", 3, "ref-uuid", "MTN")
    expect(body.service).toBe("mtn")
  })
  it("sets service to telecel for the Telecel network", () => {
    const body = buildQueuePayload("0241234567", 3, "ref-uuid", "Telecel")
    expect(body.service).toBe("telecel")
  })
  it("sets service to airteltigo for the AirtelTigo network", () => {
    const body = buildQueuePayload("0241234567", 3, "ref-uuid", "AirtelTigo")
    expect(body.service).toBe("airteltigo")
  })
  it("passes the reference through unchanged", () => {
    const body = buildQueuePayload("0241234567", 5, "my-uuid-123", "MTN")
    expect(body.items[0].reference).toBe("my-uuid-123")
  })
  it("passes the msisdn through unchanged", () => {
    const body = buildQueuePayload("0241234567", 5, "r", "MTN")
    expect(body.items[0].msisdn).toBe("0241234567")
  })
})

describe("deriveOrderStatus", () => {
  it("returns null when no count fields are present (caller should try another source)", () => {
    expect(deriveOrderStatus({ processing_status: "DONE" })).toBeNull()
  })

  it("does NOT trust counts while processing_status isn't DONE — retriable failures (§8) can flip to success", () => {
    expect(deriveOrderStatus({ success_count: 0, failure_count: 1, processing_status: "IN_PROGRESS" })).toBe("processing")
    expect(deriveOrderStatus({ success_count: 1, failure_count: 0, processing_status: "IN_PROGRESS" })).toBe("processing")
  })

  it("returns processing when processing_status is entirely absent, even with counts present", () => {
    expect(deriveOrderStatus({ success_count: 1, failure_count: 0 })).toBe("processing")
  })

  it("returns completed when DONE with success_count > 0 and failure_count is 0", () => {
    expect(deriveOrderStatus({ success_count: 1, failure_count: 0, processing_status: "DONE" })).toBe("completed")
  })

  it("returns failed when DONE with failure_count > 0 and success_count is 0", () => {
    expect(deriveOrderStatus({ success_count: 0, failure_count: 1, processing_status: "DONE" })).toBe("failed")
  })

  it("treats DONE with zero success and zero failure as failed (e.g. all items came back missing)", () => {
    expect(deriveOrderStatus({ success_count: 0, failure_count: 0, processing_status: "DONE" })).toBe("failed")
  })

  it("falls back to legacy 'status' field if processing_status is absent", () => {
    expect(deriveOrderStatus({ success_count: 1, failure_count: 0, status: "DONE" })).toBe("completed")
  })
})
