import { describe, it, expect, vi } from "vitest"
import { scrollToEnd } from "./scroll"

describe("scrollToEnd", () => {
  it("scrolls only the given list to its last pixel", () => {
    const scrollTo = vi.fn()
    scrollToEnd({ scrollHeight: 1800, scrollTo } as unknown as HTMLElement)
    expect(scrollTo).toHaveBeenCalledWith({ top: 1800, behavior: "smooth" })
  })

  it("can jump without animation", () => {
    const scrollTo = vi.fn()
    scrollToEnd({ scrollHeight: 40, scrollTo } as unknown as HTMLElement, false)
    expect(scrollTo).toHaveBeenCalledWith({ top: 40, behavior: "auto" })
  })

  it("does nothing when the list is not mounted", () => {
    expect(() => scrollToEnd(null)).not.toThrow()
  })
})
