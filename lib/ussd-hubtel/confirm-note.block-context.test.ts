import { describe, it, expect, vi } from "vitest"
import { confirmNote, recipientBlockedAtPay } from "./confirm-note"
import type { FlowCtx } from "./flow-kit"

function ctxWith(session: Record<string, unknown>) {
  const verifyRecipient = vi.fn(async () => "blocked" as const)
  const defer = vi.fn()
  const ctx = {
    req: { Mobile: "233244000111", SessionId: "S1" },
    session,
    deps: { verifyRecipient, defer },
  } as unknown as FlowCtx
  return { ctx, verifyRecipient, defer }
}

describe("Hubtel recipient check: block context", () => {
  it("main menu: ussd_hubtel with the caller, no shop, and the deferral hook", async () => {
    const { ctx, verifyRecipient, defer } = ctxWith({ mode: "main" })
    await confirmNote(ctx, { network: "MTN", recipientLocal: "0244123456", verify: true, estimate: null })
    expect(verifyRecipient).toHaveBeenCalledWith(
      "0244123456",
      expect.objectContaining({ surface: "ussd_hubtel", shopId: null, purchaserPhone: "233244000111" }),
      defer
    )
  })

  it("shop menu: ussd_hubtel_shop with the shop id, at the confirm screen and at Pay now", async () => {
    const shopId = "11111111-1111-4111-8111-111111111111"
    const { ctx, verifyRecipient, defer } = ctxWith({ mode: "shop", shopId })
    await confirmNote(ctx, { network: "MTN", recipientLocal: "0244123456", verify: true, estimate: null })
    expect(await recipientBlockedAtPay(ctx, "MTN", "0244123456")).toBe(true)
    expect(verifyRecipient).toHaveBeenCalledTimes(2)
    for (const call of verifyRecipient.mock.calls as unknown[][]) {
      expect(call[1]).toEqual(expect.objectContaining({ surface: "ussd_hubtel_shop", shopId, purchaserPhone: "233244000111" }))
      expect(call[2]).toBe(defer)
    }
  })
})
