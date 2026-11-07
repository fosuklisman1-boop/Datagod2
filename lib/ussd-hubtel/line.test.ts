import { describe, it, expect } from "vitest"
import { parseHubtelLine } from "./line"

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
