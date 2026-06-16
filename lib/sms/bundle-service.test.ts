import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.mock factories are hoisted above the module under test, which initializes its
// supabase client at import time. So the fake client + mutable state must also be hoisted
// (via vi.hoisted) to exist before that import runs. This keeps the production module on
// the repo's standard module-level client pattern — the workaround lives only in the test.
const h = vi.hoisted(() => {
  const state = { walletBalance: 0, wholesale: 0, calls: [] as { fn: string; args: any }[] }
  const bundleRow = { id: "b1", name: "5k", units: 5000, price_ghs: 150, owner_type_scope: "all", active: true }
  const notifySpy = vi.fn()
  const fake = {
    rpc: (fn: string, args: any) => {
      state.calls.push({ fn, args })
      if (fn === "deduct_wallet") {
        if (args.p_amount < 0) {
          state.walletBalance += -args.p_amount
          return Promise.resolve({ data: [{ new_balance: state.walletBalance }], error: null })
        }
        if (state.walletBalance >= args.p_amount) {
          state.walletBalance -= args.p_amount
          return Promise.resolve({ data: [{ new_balance: state.walletBalance }], error: null })
        }
        return Promise.resolve({ data: [], error: null })
      }
      if (fn === "credit_sms_units_if_solvent") {
        if (args.p_units <= state.wholesale) {
          return Promise.resolve({ data: [{ outcome: "credited", balance_after: args.p_units }], error: null })
        }
        return Promise.resolve({ data: [{ outcome: "pending", balance_after: null }], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: (_t: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: bundleRow, error: null }) }) }),
    }),
  }
  return { state, fake, notifySpy }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({ queryMoolreSmsBalance: () => Promise.resolve(h.state.wholesale) }))
vi.mock("./notify", () => ({ notifyAdminSmsShortfall: (...a: any[]) => { h.notifySpy(...a); return Promise.resolve() } }))

import { purchaseBundleViaWallet } from "./bundle-service"

beforeEach(() => {
  h.state.calls.length = 0
  h.notifySpy.mockClear()
})

describe("purchaseBundleViaWallet (solvency-gated)", () => {
  it("funded wallet + solvent → credited, no admin notify", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("credited")
    expect(res.pending).toBe(false)
    expect(h.state.calls.map((c) => c.fn)).toEqual(["deduct_wallet", "credit_sms_units_if_solvent"])
    expect(h.notifySpy).not.toHaveBeenCalled()
  })

  it("funded wallet + insolvent → pending + admin notified", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 0
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("pending")
    expect(res.pending).toBe(true)
    expect(h.notifySpy).toHaveBeenCalledWith(5000)
  })

  it("insufficient wallet → no credit attempted", async () => {
    h.state.walletBalance = 10; h.state.wholesale = 1_000_000
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(false)
    expect(h.state.calls.map((c) => c.fn)).toEqual(["deduct_wallet"])
  })
})
