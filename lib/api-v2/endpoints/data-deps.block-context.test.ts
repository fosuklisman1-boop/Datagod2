import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: vi.fn() }))
const verify = vi.hoisted(() => vi.fn())
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ verifyRecipientsForOrder: verify }))

import { realDataDeps } from "./data-deps"

describe("realDataDeps.verifyMtn block context", () => {
  beforeEach(() => {
    verify.mockReset().mockResolvedValue({ verdicts: new Map([["0249990417", false]]), blocking: true, blocked: ["0249990417"] })
  })

  it("an order placement passes the api_v2 surface and the key owner", async () => {
    await realDataDeps().verifyMtn(["0249990417"], { userId: "user-1" })
    expect(verify).toHaveBeenCalledWith(
      ["0249990417"],
      expect.objectContaining({ context: { surface: "api_v2", userId: "user-1" } })
    )
  })

  it("verify-number (no ctx) records nothing: no context is passed", async () => {
    await realDataDeps().verifyMtn(["0249990417"])
    expect(verify.mock.calls[0][1]).not.toHaveProperty("context")
  })
})
