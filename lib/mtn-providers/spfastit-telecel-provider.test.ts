import { describe, it, expect } from "vitest"
import { mapSpfastitTelecelStatus, gbToMb } from "./spfastit-telecel-provider"

describe("mapSpfastitTelecelStatus", () => {
  it("maps completed", () => {
    expect(mapSpfastitTelecelStatus("completed")).toBe("completed")
    expect(mapSpfastitTelecelStatus("Completed")).toBe("completed")
  })

  it("maps served to completed — a real value seen live, not documented", () => {
    expect(mapSpfastitTelecelStatus("served")).toBe("completed")
    expect(mapSpfastitTelecelStatus("Served")).toBe("completed")
  })

  it("maps anything containing fail/cancel/reject/block to failed", () => {
    expect(mapSpfastitTelecelStatus("failed")).toBe("failed")
    expect(mapSpfastitTelecelStatus("cancelled")).toBe("failed")
    expect(mapSpfastitTelecelStatus("rejected")).toBe("failed")
    expect(mapSpfastitTelecelStatus("blocked")).toBe("failed")
  })

  it("maps initiated, processing, and unrecognized values to processing", () => {
    expect(mapSpfastitTelecelStatus("initiated")).toBe("processing")
    expect(mapSpfastitTelecelStatus("processing")).toBe("processing")
    expect(mapSpfastitTelecelStatus("something_new")).toBe("processing")
  })
})

describe("gbToMb", () => {
  it("converts GB to MB at the 1000MB=1GB rate confirmed for this API's Telecel sizes", () => {
    expect(gbToMb(10)).toBe(10000)
    expect(gbToMb(50)).toBe(50000)
  })
})
