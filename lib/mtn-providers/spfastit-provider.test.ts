import { mapSpfastitStatus } from "@/lib/mtn-providers/spfastit-provider"

describe("mapSpfastitStatus", () => {
  it("maps in-flight statuses to processing", () => {
    expect(mapSpfastitStatus("queued")).toBe("processing")
    expect(mapSpfastitStatus("processing")).toBe("processing")
    expect(mapSpfastitStatus("pending_retry")).toBe("processing")
  })
  it("maps completed to completed", () => {
    expect(mapSpfastitStatus("completed")).toBe("completed")
  })
  it("maps every documented failure status to failed", () => {
    expect(mapSpfastitStatus("failed")).toBe("failed")
    expect(mapSpfastitStatus("failed_blocked")).toBe("failed")
    expect(mapSpfastitStatus("billed_failure")).toBe("failed")
  })
  it("is case-insensitive and trims whitespace", () => {
    expect(mapSpfastitStatus(" COMPLETED ")).toBe("completed")
  })
  it("defaults an unrecognized status to processing rather than guessing failed", () => {
    expect(mapSpfastitStatus("some_new_status")).toBe("processing")
  })
})
