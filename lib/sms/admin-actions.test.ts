import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  allocate: vi.fn(),
  audit: vi.fn((..._a: any[]) => Promise.resolve()),
  user: { data: { id: "x", user_id: "owner1" } as any, error: null as any },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(h.user) }) }) }) }),
}))
vi.mock("./bundle-service", () => ({ allocateUnits: h.allocate }))
vi.mock("./moderation-service", () => ({ writeAuditLog: h.audit }))

import { allocateCredits, MAX_ALLOCATION } from "./admin-actions"

const ACCT = "11111111-1111-4111-8111-111111111111"
const REQ = "22222222-2222-4222-8222-222222222222"
beforeEach(() => {
  h.allocate.mockReset(); h.audit.mockClear(); h.audit.mockImplementation(() => Promise.resolve())
  h.user = { data: { id: ACCT, user_id: "owner1" }, error: null }
})

describe("allocateCredits", () => {
  it("allocates, audits with the account owner as target, and reports pending", async () => {
    h.allocate.mockResolvedValue({ ok: true, pending: true, unitsCredited: 0, outcome: "pending" })
    expect(await allocateCredits("admin1", ACCT, 500)).toEqual({ ok: true, pending: true, unitsCredited: 0 })
    expect(h.allocate).toHaveBeenCalledWith(ACCT, 500, null)
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
  it("returns 'Account not found' without allocating when the account is missing", async () => {
    h.user = { data: null, error: null }
    expect(await allocateCredits("admin1", ACCT, 5)).toEqual({ ok: false, error: "Account not found" })
    expect(h.allocate).not.toHaveBeenCalled()
  })
  it("fails (no allocation) when the account lookup errors", async () => {
    h.user = { data: null, error: { message: "db" } }
    expect((await allocateCredits("admin1", ACCT, 5)).ok).toBe(false)
    expect(h.allocate).not.toHaveBeenCalled()
  })
  it("rejects an invalid requestId without allocating", async () => {
    expect(await allocateCredits("admin1", ACCT, 5, "not-a-uuid")).toEqual({ ok: false, error: "Invalid request id" })
    expect(h.allocate).not.toHaveBeenCalled()
  })
  it("uses ref admin_alloc:<requestId> and records requestId in the audit", async () => {
    h.allocate.mockResolvedValue({ ok: true, pending: false, unitsCredited: 5, outcome: "credited" })
    await allocateCredits("admin1", ACCT, 5, REQ)
    expect(h.allocate).toHaveBeenCalledWith(ACCT, 5, `admin_alloc:${REQ}`)
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_credits_allocate", "owner1", null, { accountId: ACCT, units: 5, pending: false, requestId: REQ })
  })
  it("same requestId twice credits once: the repeat is a duplicate with no second audit row", async () => {
    h.allocate
      .mockResolvedValueOnce({ ok: true, pending: false, unitsCredited: 5, outcome: "credited" })
      .mockResolvedValueOnce({ ok: true, pending: false, unitsCredited: 0, outcome: "duplicate" })
    expect(await allocateCredits("admin1", ACCT, 5, REQ)).toEqual({ ok: true, pending: false, unitsCredited: 5 })
    expect(await allocateCredits("admin1", ACCT, 5, REQ)).toEqual({ ok: true, pending: false, unitsCredited: 0, duplicate: true })
    expect(h.audit).toHaveBeenCalledTimes(1)
  })
  it("still succeeds (and logs) when the audit write throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.allocate.mockResolvedValue({ ok: true, pending: false, unitsCredited: 5, outcome: "credited" })
    h.audit.mockImplementation(() => Promise.reject(new Error("audit down")))
    expect((await allocateCredits("admin1", ACCT, 5)).ok).toBe(true)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
