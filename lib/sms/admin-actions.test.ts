import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ allocate: vi.fn(), audit: vi.fn(() => Promise.resolve()), user: { data: { user_id: "owner1" } as any } }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(h.user) }) }) }) }),
}))
vi.mock("./bundle-service", () => ({ allocateUnits: h.allocate }))
vi.mock("./moderation-service", () => ({ writeAuditLog: h.audit }))

import { allocateCredits, MAX_ALLOCATION } from "./admin-actions"

const ACCT = "11111111-1111-4111-8111-111111111111"
beforeEach(() => { h.allocate.mockReset(); h.audit.mockClear(); h.user = { data: { user_id: "owner1" } } })

describe("allocateCredits", () => {
  it("allocates, audits with the account owner as target, and reports pending", async () => {
    h.allocate.mockResolvedValue({ ok: true, pending: true, unitsCredited: 0 })
    expect(await allocateCredits("admin1", ACCT, 500)).toEqual({ ok: true, pending: true, unitsCredited: 0 })
    expect(h.allocate).toHaveBeenCalledWith(ACCT, 500)
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_credits_allocate", "owner1", null, { accountId: ACCT, units: 500, pending: true })
  })
  it("refuses a missing admin id, bad account id and bad unit counts without allocating", async () => {
    expect((await allocateCredits("", ACCT, 5)).ok).toBe(false)
    expect((await allocateCredits("a", "nope", 5)).ok).toBe(false)
    for (const u of [0, -1, 1.5, NaN, MAX_ALLOCATION + 1]) expect((await allocateCredits("a", ACCT, u as number)).ok).toBe(false)
    expect(h.allocate).not.toHaveBeenCalled()
  })
  it("surfaces an allocation failure and writes no audit row", async () => {
    h.allocate.mockResolvedValue({ ok: false, error: "units must be a positive integer" })
    expect(await allocateCredits("admin1", ACCT, 5)).toEqual({ ok: false, error: "units must be a positive integer" })
    expect(h.audit).not.toHaveBeenCalled()
  })
})
