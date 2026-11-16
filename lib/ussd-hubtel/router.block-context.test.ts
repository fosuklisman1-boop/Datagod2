import { describe, it, expect, vi } from "vitest"

const verify = vi.hoisted(() => vi.fn())
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ verifyRecipientsForOrder: verify }))

import { defaultRouterDeps } from "./router"

describe("defaultRouterDeps.verifyRecipient: block context", () => {
  it("forwards the context and the defer hook to the shared gate, and still reports blocked", async () => {
    verify.mockResolvedValue({ verdicts: new Map([["0244123456", false]]), blocking: true, blocked: ["0244123456"] })
    const defer = vi.fn()
    const context = { surface: "ussd_hubtel" as const, purchaserPhone: "233244000111" }
    const out = await defaultRouterDeps({} as any).verifyRecipient!("0244123456", context, defer)
    expect(out).toBe("blocked")
    expect(verify).toHaveBeenCalledWith(["0244123456"], expect.objectContaining({ timeoutMs: 12_000, context, defer }))
  })

  it("without a context the gate is called as before (nothing recorded)", async () => {
    verify.mockClear().mockResolvedValue({ verdicts: new Map([["0244123456", true]]), blocking: false, blocked: [] })
    expect(await defaultRouterDeps({} as any).verifyRecipient!("0244123456")).toBe(true)
    expect(verify.mock.calls[0][1]).not.toHaveProperty("context")
  })
})
