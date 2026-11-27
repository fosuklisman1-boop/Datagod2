import { describe, expect, it, vi } from "vitest"
import { closeWidgetDuringCall } from "./close-widget"

const run = (callActive: boolean, source: "button" | "escape" | "backdrop") => {
  const hangUp = vi.fn()
  const close = vi.fn()
  closeWidgetDuringCall({ callActive, source, hangUp, close })
  return { hangUp, close }
}

describe("closeWidgetDuringCall", () => {
  it("just closes when no call is active", () => {
    for (const s of ["button", "escape", "backdrop"] as const) {
      const r = run(false, s)
      expect(r.hangUp).not.toHaveBeenCalled()
      expect(r.close).toHaveBeenCalledOnce()
    }
  })
  it("hangs up then closes for button and escape during a call", () => {
    for (const s of ["button", "escape"] as const) {
      const r = run(true, s)
      expect(r.hangUp).toHaveBeenCalledOnce()
      expect(r.close).toHaveBeenCalledOnce()
    }
  })
  it("ignores a backdrop click during a call", () => {
    const r = run(true, "backdrop")
    expect(r.hangUp).not.toHaveBeenCalled()
    expect(r.close).not.toHaveBeenCalled()
  })
})
