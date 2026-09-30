import { describe, it, expect } from "vitest"
import { networkNickname, NETWORK_NICKNAMES } from "./network-labels"

describe("networkNickname", () => {
  it("maps MTN to Yellow Plans", () => {
    expect(networkNickname("MTN")).toBe("Yellow Plans")
  })

  it("maps Telecel to Tele", () => {
    expect(networkNickname("Telecel")).toBe("Tele")
  })

  it("maps AT-iShare to Instant Blue", () => {
    expect(networkNickname("AT-iShare")).toBe("Instant Blue")
  })

  it("maps AT-BigTime to Delay Blue", () => {
    expect(networkNickname("AT-BigTime")).toBe("Delay Blue")
  })

  it("falls back to the raw value for an unrecognized network (e.g. a legacy generic AirtelTigo row)", () => {
    expect(networkNickname("AirtelTigo")).toBe("AirtelTigo")
  })

  it("exports exactly the 4 expected networks", () => {
    expect(Object.keys(NETWORK_NICKNAMES).sort()).toEqual(
      ["AT-BigTime", "AT-iShare", "MTN", "Telecel"].sort()
    )
  })
})
