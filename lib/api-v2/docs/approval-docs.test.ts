import { describe, it, expect } from "vitest"
import { v2DocsRegistry } from "./registry"

const allText = JSON.stringify(v2DocsRegistry)

describe("docs: live-key approval", () => {
  it("explains the request code and the Message admin button", () => {
    expect(allText).toMatch(/request code/i)
    expect(allText).toContain("Message admin")
  })
  it("says a replaced live key keeps working until the new one is approved", () => {
    expect(allText).toMatch(/current live key keeps working until/i)
  })
  it("explains how accounts without API access ask for it", () => {
    expect(allText).toContain("Request API access")
  })
})
