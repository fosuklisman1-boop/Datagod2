import {
  mapItemStatus,
  buildQueuePayload,
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
