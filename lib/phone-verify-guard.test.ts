import { describe, it, expect, vi, beforeEach } from "vitest"

let gateDisabled = false
vi.mock("@/lib/storefront-otp", () => ({ isPhoneGateDisabled: async () => gateDisabled }))

import { checkPhoneVerified } from "./phone-verify-guard"

const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const PAST = new Date(Date.now() - 86_400_000).toISOString()

function db(row: { phone_verified: boolean; phone_verify_deadline: string | null } | null, error: unknown = null) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: row, error }) }) }) }),
  } as any
}

describe("checkPhoneVerified", () => {
  beforeEach(() => { gateDisabled = false })

  it("allows a verified phone", async () => {
    expect((await checkPhoneVerified(db({ phone_verified: true, phone_verify_deadline: null }), "u")).allowed).toBe(true)
  })

  it("allows an unverified account inside its grace window by default (orders, withdrawals)", async () => {
    expect((await checkPhoneVerified(db({ phone_verified: false, phone_verify_deadline: FUTURE }), "u")).allowed).toBe(true)
  })

  it("blocks an unverified account inside its grace window when allowGrace is false (shop creation)", async () => {
    const r = await checkPhoneVerified(db({ phone_verified: false, phone_verify_deadline: FUTURE }), "u", { allowGrace: false })
    expect(r.allowed).toBe(false)
    expect(r.error).toMatch(/verify your phone/i)
  })

  it("blocks an unverified account past its deadline, and one with no deadline", async () => {
    expect((await checkPhoneVerified(db({ phone_verified: false, phone_verify_deadline: PAST }), "u")).allowed).toBe(false)
    expect((await checkPhoneVerified(db({ phone_verified: false, phone_verify_deadline: null }), "u")).allowed).toBe(false)
  })

  it("the admin kill switch still opens the gate even when allowGrace is false", async () => {
    gateDisabled = true
    expect((await checkPhoneVerified(db({ phone_verified: false, phone_verify_deadline: null }), "u", { allowGrace: false })).allowed).toBe(true)
  })

  it("fails closed on a read error", async () => {
    expect((await checkPhoneVerified(db(null, { message: "down" }), "u", { allowGrace: false })).allowed).toBe(false)
  })
})
