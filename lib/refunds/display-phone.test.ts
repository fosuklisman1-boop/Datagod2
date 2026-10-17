import { describe, it, expect } from "vitest"
import { displayPhone } from "./orders"

describe("displayPhone", () => {
  it("shows any Ghana number as 0XXXXXXXXX", () => {
    expect(displayPhone("+233241112222")).toBe("0241112222")
    expect(displayPhone("233241112222")).toBe("0241112222")
    expect(displayPhone("0241112222")).toBe("0241112222")
    expect(displayPhone(" +233 24 111 2222 ")).toBe("0241112222")
  })
  it("keeps anything that isn't a Ghana number as stored, and blanks as null", () => {
    expect(displayPhone("12345")).toBe("12345")
    expect(displayPhone("")).toBeNull()
    expect(displayPhone(null)).toBeNull()
    expect(displayPhone(undefined)).toBeNull()
  })
})
