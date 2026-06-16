import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.mock factories are hoisted above the module under test, which initializes its
// supabase client at import time. So the fake client + mutable state must also be hoisted
// (via vi.hoisted) to exist before that import runs. This keeps the production module on
// the repo's standard module-level client pattern — the workaround lives only in the test.
const h = vi.hoisted(() => {
  const state = {
    walletBalance: 0,
    wholesale: 0,
    creditError: false, // force credit_sms_units_if_solvent to return an error
    refInTx: false, // ref already landed in sms_unit_transactions
    refInPending: false, // ref already landed in sms_pending_credits
    pricePerCredit: 0.05, // sms_price_per_credit setting
    calls: [] as { fn: string; args: any }[],
  }
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
        if (state.creditError) return Promise.resolve({ data: null, error: { message: "boom" } })
        if (args.p_units <= state.wholesale) {
          return Promise.resolve({ data: [{ outcome: "credited", balance_after: args.p_units }], error: null })
        }
        return Promise.resolve({ data: [{ outcome: "pending", balance_after: null }], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            if (table === "sms_bundles") return Promise.resolve({ data: bundleRow, error: null })
            if (table === "sms_unit_transactions") return Promise.resolve({ data: state.refInTx ? { id: "x" } : null, error: null })
            if (table === "sms_pending_credits") return Promise.resolve({ data: state.refInPending ? { id: "y" } : null, error: null })
            if (table === "tenant_global_settings") return Promise.resolve({ data: { value: { amount: state.pricePerCredit } }, error: null })
            if (table === "sms_accounts") {
              return Promise.resolve({
                data: {
                  status: (fake as any)._accountStatus ?? "active",
                  owner_type: (fake as any)._ownerType ?? "shop",
                },
                error: null,
              })
            }
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }),
    }),
  }
  return { state, fake, notifySpy }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({ queryMoolreSmsBalance: () => Promise.resolve(h.state.wholesale) }))
vi.mock("./notify", () => ({ notifyAdminSmsShortfall: (...a: any[]) => { h.notifySpy(...a); return Promise.resolve() } }))

import { purchaseBundleViaWallet, purchaseUnitsByQuantity, quoteCredits, getPricePerCredit } from "./bundle-service"

beforeEach(() => {
  h.state.calls.length = 0
  h.state.creditError = false
  h.state.refInTx = false
  h.state.refInPending = false
  h.state.pricePerCredit = 0.05
  h.notifySpy.mockClear()
  // Reset activation gate overrides so existing tests are unaffected
  delete (h.fake as any)._accountStatus
  delete (h.fake as any)._ownerType
})

const fns = () => h.state.calls.map((c) => c.fn)

describe("purchaseBundleViaWallet (solvency-gated)", () => {
  it("funded wallet + solvent → credited, no admin notify", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("credited")
    expect(res.pending).toBe(false)
    expect(fns()).toEqual(["deduct_wallet", "credit_sms_units_if_solvent"])
    expect(h.notifySpy).not.toHaveBeenCalled()
  })

  it("funded wallet + insolvent → pending + admin notified (cash retained, no refund)", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 0
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("pending")
    expect(res.pending).toBe(true)
    expect(h.notifySpy).toHaveBeenCalledWith(5000)
    // exactly one deduct_wallet (the debit) — no refund on a legitimate pending purchase
    expect(fns().filter((f) => f === "deduct_wallet")).toHaveLength(1)
  })

  it("insufficient wallet → no credit attempted", async () => {
    h.state.walletBalance = 10; h.state.wholesale = 1_000_000
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(false)
    expect(fns()).toEqual(["deduct_wallet"])
  })

  it("issuance errors AND credit did not land → refund the cash", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000; h.state.creditError = true
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/refunded/)
    // debit + failed credit + refund (a second deduct_wallet, negative amount)
    const debits = h.state.calls.filter((c) => c.fn === "deduct_wallet")
    expect(debits).toHaveLength(2)
    expect(debits[1].args.p_amount).toBeLessThan(0)
  })

  it("issuance errors BUT credit actually landed → NO refund (avoids double money)", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000; h.state.creditError = true; h.state.refInTx = true
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("credited")
    // only the original debit — NO refund, because the units actually landed
    expect(h.state.calls.filter((c) => c.fn === "deduct_wallet")).toHaveLength(1)
  })
})

describe("purchaseBundleViaWallet — activation gate", () => {
  it("inactive account → NOT_ACTIVATED error, no wallet debit", async () => {
    h.state.walletBalance = 200
    h.state.wholesale = 1_000_000
    // Override the fake's from() to return an inactive account
    ;(h.fake as any)._accountStatus = "inactive"
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("NOT_ACTIVATED")
    expect(h.state.calls.filter((c) => c.fn === "deduct_wallet")).toHaveLength(0)
  })

  it("platform account → bypasses gate, proceeds normally", async () => {
    h.state.walletBalance = 200
    h.state.wholesale = 1_000_000
    ;(h.fake as any)._accountStatus = "active"
    ;(h.fake as any)._ownerType = "platform"
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
  })

  it("suspended account → NOT_ACTIVATED error", async () => {
    h.state.walletBalance = 200
    h.state.wholesale = 1_000_000
    ;(h.fake as any)._accountStatus = "suspended"
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("NOT_ACTIVATED")
  })
})

describe("per-credit pricing (free-quantity top-up)", () => {
  it("quoteCredits computes cost = credits × admin fee", async () => {
    h.state.pricePerCredit = 0.035
    const q = await quoteCredits(1000)
    expect(q.pricePerCredit).toBe(0.035)
    expect(q.cost).toBe(35)
  })

  it("getPricePerCredit falls back to the default when the setting is 0/unset", async () => {
    h.state.pricePerCredit = 0
    expect(await getPricePerCredit()).toBe(0.04) // DEFAULT_PRICE_PER_CREDIT
  })

  it("funded wallet → debits credits×fee and credits the requested quantity", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000; h.state.pricePerCredit = 0.05
    const res = await purchaseUnitsByQuantity("u1", "acc1", 100)
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("credited")
    expect(res.unitsCredited).toBe(100)
    expect(res.cost).toBe(5) // 100 × 0.05
    const debit = h.state.calls.find((c) => c.fn === "deduct_wallet")
    expect(debit!.args.p_amount).toBe(5)
  })

  it("rejects a non-positive / non-integer quantity without any debit", async () => {
    h.state.walletBalance = 200
    const r1 = await purchaseUnitsByQuantity("u1", "acc1", 0)
    const r2 = await purchaseUnitsByQuantity("u1", "acc1", 1.5)
    expect(r1.ok).toBe(false); expect(r2.ok).toBe(false)
    expect(h.state.calls.filter((c) => c.fn === "deduct_wallet")).toHaveLength(0)
  })

  it("insufficient wallet → error, no credit", async () => {
    h.state.walletBalance = 1; h.state.wholesale = 1_000_000; h.state.pricePerCredit = 0.05
    const res = await purchaseUnitsByQuantity("u1", "acc1", 1000) // needs GHS 50
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Insufficient/)
  })

  it("insolvent → pending (cash retained, admin notified)", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 0; h.state.pricePerCredit = 0.05
    const res = await purchaseUnitsByQuantity("u1", "acc1", 100)
    expect(res.ok).toBe(true)
    expect(res.pending).toBe(true)
    expect(h.notifySpy).toHaveBeenCalledWith(100)
  })
})
