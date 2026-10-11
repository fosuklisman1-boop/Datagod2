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
    updates: [] as { table: string; patch: any; ref: any; col?: string; val?: any }[],
    updateError: false,
    duplicate: false,
    smsEnabled: true, // master kill switch
    bundleMissing: false, // sms_bundles lookup returns nothing
    deletes: [] as { table: string; cols: [string, any][] }[],
    deleteError: false,
    inserts: [] as { table: string; row: any }[],
  }
  const bundleRow = { id: "b1", name: "5k", units: 5000, price_ghs: 150, owner_type_scope: "all", active: true, mode: "platform", sort_order: 0 }
  const notifySpy = vi.fn()
  const fake: any = {
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
        if (state.duplicate) return Promise.resolve({ data: [{ outcome: "duplicate", balance_after: null }], error: null })
        if (args.p_units <= state.wholesale) {
          return Promise.resolve({ data: [{ outcome: "credited", balance_after: args.p_units }], error: null })
        }
        return Promise.resolve({ data: [{ outcome: "pending", balance_after: null }], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => ({
      insert: (row: any) => {
        state.inserts.push({ table, row })
        return Promise.resolve({ data: null, error: null })
      },
      delete: () => {
        const cols: [string, any][] = []
        const chain: any = {
          eq: (c: string, v: any) => {
            cols.push([c, v])
            if (cols.length < 2) return chain
            state.deletes.push({ table, cols })
            return Promise.resolve({ data: null, error: state.deleteError ? { message: "del boom" } : null })
          },
        }
        return chain
      },
      update: (patch: any) => ({
        eq: (_c: string, ref: any) => ({
          is: (col: string, val: any) => {
            state.updates.push({ table, patch, ref, col, val })
            return Promise.resolve({ data: null, error: state.updateError ? { message: "upd boom" } : null })
          },
        }),
      }),
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            if (table === "sms_bundles") return Promise.resolve({ data: state.bundleMissing ? null : bundleRow, error: null })
            if (table === "sms_unit_transactions") return Promise.resolve({ data: state.refInTx ? { id: "x" } : null, error: null })
            if (table === "sms_pending_credits") return Promise.resolve({ data: state.refInPending ? { id: "y" } : null, error: null })
            if (table === "tenant_global_settings") return Promise.resolve({ data: { value: { amount: state.pricePerCredit } }, error: null })
            if (table === "sms_accounts") {
              return Promise.resolve({
                data: {
                  status: (fake as any)._accountStatus ?? "active",
                  owner_type: (fake as any)._ownerType ?? "shop",
                  mode: (fake as any)._accountMode ?? "platform",
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
  return { state, fake, notifySpy, bundleRow }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("./wholesale", () => ({ getWholesaleCredits: () => Promise.resolve(h.state.wholesale) }))
vi.mock("./kill-switch", () => ({ isSmsEnabled: () => Promise.resolve(h.state.smsEnabled) }))
vi.mock("./notify", () => ({ notifyAdminSmsShortfall: (...a: any[]) => { h.notifySpy(...a); return Promise.resolve() } }))

import { purchaseBundleViaWallet, purchaseUnitsByQuantity, quoteCredits, getPricePerCredit, creditUnitsForPaystack, allocateUnits, canDeleteBundle, BUNDLE_DELETE_MIN_INACTIVE_MS, deleteBundle } from "./bundle-service"

beforeEach(() => {
  h.state.calls.length = 0
  h.state.updates.length = 0
  h.state.updateError = false
  h.state.duplicate = false
  h.state.smsEnabled = true
  h.state.bundleMissing = false
  h.state.deletes.length = 0
  h.state.deleteError = false
  h.state.inserts.length = 0
  delete (h.bundleRow as any).updated_at
  h.bundleRow.active = true
  h.bundleRow.owner_type_scope = "all"
  delete (h.fake as any)._accountMode
  h.bundleRow.mode = "platform"
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

describe("per-mode bundles + revenue", () => {
  it("business bundle from a platform account → mode error, no wallet debit", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    h.bundleRow.mode = "business"
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/account mode/)
    expect(h.state.calls.filter((c) => c.fn === "deduct_wallet")).toHaveLength(0)
  })

  it("matching business mode purchases fine", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    h.bundleRow.mode = "business"
    ;(h.fake as any)._accountMode = "business"
    expect((await purchaseBundleViaWallet("u1", "acc1", "b1")).ok).toBe(true)
  })

  it("wallet purchase records the price paid on ledger and pending rows", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(h.state.updates.map((u) => u.table).sort()).toEqual(["sms_pending_credits", "sms_unit_transactions"])
    expect(h.state.updates.every((u) => u.patch.amount_ghs === 150)).toBe(true)
  })

  it("quantity purchase records its cost; paystack credit records the paid amount", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000; h.state.pricePerCredit = 0.05
    await purchaseUnitsByQuantity("u1", "acc1", 100)
    expect(h.state.updates.length).toBe(2)
    expect(h.state.updates.every((u) => u.patch.amount_ghs === 5)).toBe(true)
    h.state.updates.length = 0
    await creditUnitsForPaystack("acc1", 100, "ps-ref", 12.5)
    expect(h.state.updates).toHaveLength(2)
    expect(h.state.updates.every((u) => u.patch.amount_ghs === 12.5 && u.ref === "ps-ref")).toBe(true)
  })

  it("revenue writes are guarded with amount_ghs IS NULL (never overwrite)", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(h.state.updates.length).toBe(2)
    expect(h.state.updates.every((u) => u.col === "amount_ghs" && u.val === null)).toBe(true)
  })

  it("duplicate Paystack redelivery still attempts the guarded fill", async () => {
    h.state.duplicate = true
    const res = await creditUnitsForPaystack("acc1", 100, "ps-dup", 20)
    expect(res.outcome).toBe("duplicate")
    expect(h.state.updates).toHaveLength(2)
    expect(h.state.updates.every((u) => u.patch.amount_ghs === 20 && u.col === "amount_ghs" && u.val === null)).toBe(true)
  })

  it("an update error is logged, not thrown, and the purchase still succeeds", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000; h.state.updateError = true
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("landed branch (RPC errored but credit landed) still records the amount", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000; h.state.creditError = true; h.state.refInTx = true
    await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(h.state.updates).toHaveLength(2)
    expect(h.state.updates.every((u) => u.patch.amount_ghs === 150)).toBe(true)
    h.state.updates.length = 0
    h.state.pricePerCredit = 0.05
    await purchaseUnitsByQuantity("u1", "acc1", 100)
    expect(h.state.updates.every((u) => u.patch.amount_ghs === 5)).toBe(true)
    expect(h.state.updates.length).toBe(2)
  })

  it("inactive or out-of-scope bundle is refused before any debit", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    h.bundleRow.owner_type_scope = "sub_agent"
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    h.bundleRow.owner_type_scope = "all"
    expect(res.ok).toBe(false)
    expect(h.state.calls.filter((c) => c.fn === "deduct_wallet")).toHaveLength(0)
  })

  it("admin allocation never records revenue", async () => {
    h.state.wholesale = 1_000_000
    await allocateUnits("acc1", 100)
    expect(h.state.updates).toHaveLength(0)
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

describe("kill switch (SMS_DISABLED)", () => {
  it("wallet bundle purchase is blocked: no wallet debit, no credit RPC", async () => {
    h.state.smsEnabled = false; h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res).toEqual({ ok: false, error: "SMS_DISABLED" })
    expect(h.state.calls).toHaveLength(0)
    expect(h.state.walletBalance).toBe(200)
  })

  it("quantity purchase is blocked: no wallet debit, no credit RPC", async () => {
    h.state.smsEnabled = false; h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    const res = await purchaseUnitsByQuantity("u1", "acc1", 100)
    expect(res).toEqual({ ok: false, error: "SMS_DISABLED" })
    expect(h.state.calls).toHaveLength(0)
    expect(h.state.walletBalance).toBe(200)
  })

  it("switch on: both purchases still work", async () => {
    h.state.walletBalance = 200; h.state.wholesale = 1_000_000
    expect((await purchaseBundleViaWallet("u1", "acc1", "b1")).outcome).toBe("credited")
    expect((await purchaseUnitsByQuantity("u1", "acc1", 100)).outcome).toBe("credited")
  })

  it("NEVER blocked: creditUnitsForPaystack (webhook for an already-made payment) still credits", async () => {
    h.state.smsEnabled = false; h.state.wholesale = 1_000_000
    const res = await creditUnitsForPaystack("acc1", 500, "ps-ref-off", 20)
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("credited")
    expect(fns()).toContain("credit_sms_units_if_solvent")
  })

  it("NEVER blocked: admin allocateUnits still credits", async () => {
    h.state.smsEnabled = false; h.state.wholesale = 1_000_000
    const res = await allocateUnits("acc1", 250)
    expect(res.ok).toBe(true)
    expect(res.outcome).toBe("credited")
    expect(fns()).toContain("credit_sms_units_if_solvent")
  })
})

describe("canDeleteBundle (pure)", () => {
  const now = Date.parse("2026-10-11T12:00:00Z")
  it("refuses an active bundle", () => {
    expect(canDeleteBundle({ active: true, updated_at: "2026-01-01T00:00:00Z" }, now))
      .toEqual({ ok: false, error: "Deactivate the bundle first" })
  })
  it("refuses a bundle deactivated less than 48 h ago", () => {
    const r = canDeleteBundle({ active: false, updated_at: new Date(now - 47 * 3600_000).toISOString() }, now)
    expect(r.ok).toBe(false)
  })
  it("refuses an unparseable updated_at", () => {
    expect(canDeleteBundle({ active: false, updated_at: "garbage" }, now).ok).toBe(false)
  })
  it("allows a bundle inactive for 48 h or more", () => {
    expect(canDeleteBundle({ active: false, updated_at: new Date(now - BUNDLE_DELETE_MIN_INACTIVE_MS).toISOString() }, now)).toEqual({ ok: true })
  })
})

describe("deleteBundle", () => {
  const old = () => new Date(Date.now() - 49 * 3600_000).toISOString()
  it("refuses an empty admin id", async () => {
    expect(await deleteBundle("", "b1")).toEqual({ ok: false, error: "Admin user required" })
    expect(h.state.deletes).toHaveLength(0)
  })
  it("not found", async () => {
    h.state.bundleMissing = true
    expect(await deleteBundle("admin1", "b1")).toEqual({ ok: false, error: "Bundle not found" })
    expect(h.state.deletes).toHaveLength(0)
  })
  it("active bundle is refused and no delete is issued", async () => {
    ;(h.bundleRow as any).updated_at = old()
    const r = await deleteBundle("admin1", "b1")
    expect(r).toEqual({ ok: false, error: "Deactivate the bundle first" })
    expect(h.state.deletes).toHaveLength(0)
    expect(h.state.inserts).toHaveLength(0)
  })
  it("recently deactivated bundle is refused", async () => {
    h.bundleRow.active = false
    ;(h.bundleRow as any).updated_at = new Date().toISOString()
    expect((await deleteBundle("admin1", "b1")).ok).toBe(false)
    expect(h.state.deletes).toHaveLength(0)
  })
  it("old inactive bundle: delete issued for that id (guarded on active=false) + audit row", async () => {
    h.bundleRow.active = false
    ;(h.bundleRow as any).updated_at = old()
    expect(await deleteBundle("admin1", "b1")).toEqual({ ok: true })
    expect(h.state.deletes).toEqual([{ table: "sms_bundles", cols: [["id", "b1"], ["active", false]] }])
    const audit = h.state.inserts.find((i) => i.table === "admin_audit_log")
    expect(audit?.row.action).toBe("sms_bundle_delete")
    expect(audit?.row.admin_id).toBe("admin1")
    expect(audit?.row.old_value).toEqual({ id: "b1", name: "5k" })
  })
  it("delete error → failure, no audit row", async () => {
    h.bundleRow.active = false
    ;(h.bundleRow as any).updated_at = old()
    h.state.deleteError = true
    expect(await deleteBundle("admin1", "b1")).toEqual({ ok: false, error: "Could not delete the bundle" })
    expect(h.state.inserts).toHaveLength(0)
  })
})
