import { describe, it, expect } from "vitest"
import { hubtelSaveBody, parseHubtelLine } from "./line"

describe("hubtelSaveBody", () => {
  it("marks a main code save so it can only reach the main code's settings", () => {
    expect(hubtelSaveBody("main", { enabled: false })).toEqual({ enabled: false, line: "main" })
  })
  it("sends a shop code save with no line, exactly as before", () => {
    expect(hubtelSaveBody("shop", { enabled: false })).toEqual({ enabled: false })
  })
  it("never lets a patch override the line", () => {
    expect(hubtelSaveBody("main", { line: "shop" })).toEqual({ line: "main" })
  })
})

describe("parseHubtelLine", () => {
  it("treats no line parameter as the existing URL", () => {
    expect(parseHubtelLine([])).toBe("default")
  })
  it("accepts exactly main", () => {
    expect(parseHubtelLine(["main"])).toBe("main")
  })
  it("rejects every other value, including repeats", () => {
    for (const bad of [[""], ["MAIN"], ["shop"], ["main "], ["main", "shop"], ["main", "main"]]) {
      expect(parseHubtelLine(bad)).toBeNull()
    }
  })
})
