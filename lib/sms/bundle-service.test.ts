import { describe, it, expect, vi, beforeEach } from "vitest"

const calls: { fn: string; args: any }[] = []
let walletBalance = 0
let wholesale = 0
const notifySpy = vi.fn()
const bundleRow = { id: "b1", name: "5k", units: 5000, price_ghs: 150, owner_type_scope: "all", active: true }

const fake = {
  rpc: (fn: string, args: any) => {
    calls.push({ fn, args })
    if (fn === "deduct_wallet") {
      if (args.p_amount < 0) { walletBalance += -args.p_amount; return Promise.resolve({ data: [{ new_balance: walletBalance }], error: null }) }
      if (walletBalance >= args.p_amount) { walletBalance -= args.p_amount; return Promise.resolve({ data: [{ new_balance: walletBalance }], error: null }) }
      return Promise.resolve({ data: [], error: null })
    }
    if (fn === "credit_sms_units_if_solvent") {
      if (args.p_units <= wholesale) return Promise.resolve({ data: [{ outcome: "credited", balance_after: args.p_units }], error: null })
      return Promise.resolve({ data: [{ outcome: "pending", balance_after: null }], error: null })
    }
    return Promise.resolve({ data: null, error: null })
  },
  from: (_t: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: bundleRow, error: null }) }) }),
  }),
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fake }))
vi.mock("@/lib/sms-service", () => ({ queryMoolreSmsBalance: () => Promise.resolve(wholesale) }))
vi.mock("./notify", () => ({ notifyAdminSmsShortfall: (...a: any[]) => { notifySpy(...a); return Promise.resolve() } }))

import { purchaseBundleViaWallet } from "./bundle-service"

beforeEach(() => { calls.length = 0; notifySpy.mockClear() })

describe("purchaseBundleViaWallet (solvency-gated)", () => {
  it("funded wallet + solvent → credited, no admin notify", async () => {
    walletBalance = 200; wholesale = 1_000_000
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("credited")
    expect(res.pending).toBe(false)
    expect(calls.map((c) => c.fn)).toEqual(["deduct_wallet", "credit_sms_units_if_solvent"])
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it("funded wallet + insolvent → pending + admin notified", async () => {
    walletBalance = 200; wholesale = 0
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("pending")
    expect(res.pending).toBe(true)
    expect(notifySpy).toHaveBeenCalledWith(5000)
  })

  it("insufficient wallet → no credit attempted", async () => {
    walletBalance = 10; wholesale = 1_000_000
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(false)
    expect(calls.map((c) => c.fn)).toEqual(["deduct_wallet"])
  })
})
