import { mapSpfastitStatus, gbToBundleMb, mbToGb } from "@/lib/mtn-providers/spfastit-provider"

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

// SPFastIT explicitly documents 1000MB = 1GB (not the binary 1024 convention
// used elsewhere) — confirmed independently by their own check_balance example
// response: wallet_balance_mb: 100000, wallet_balance_gb: 100 → 100000/100 = 1000.
describe("gbToBundleMb", () => {
  it("converts using SPFastIT's documented 1000MB = 1GB, not 1024", () => {
    expect(gbToBundleMb(1)).toBe(1000)
    expect(gbToBundleMb(2)).toBe(2000)
    expect(gbToBundleMb(5)).toBe(5000)
  })
  it("rounds fractional GB to the nearest whole MB", () => {
    expect(gbToBundleMb(0.5)).toBe(500)
    expect(gbToBundleMb(1.5)).toBe(1500)
  })
})

describe("mbToGb", () => {
  it("converts using the same documented 1000MB = 1GB ratio", () => {
    expect(mbToGb(1000)).toBe(1)
    expect(mbToGb(100000)).toBe(100) // matches the docs' own wallet_balance_mb/gb example
    expect(mbToGb(95000)).toBe(95)   // matches the docs' own available_mb/gb example
  })
})
