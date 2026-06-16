// lib/sms/activation-service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    accountStatus: "inactive" as string,  // current sms_accounts.status
    ownerType: "shop" as string,
    walletBalance: 0,
    wholesale: 1_000_000,
    activationFee: 20,
    welcomeBonus: 10,
    activationRpcError: null as string | null, // force activate_sms_account to error
    bonusRpcError: null as string | null,      // force claim_sms_welcome_bonus to error
    creditOutcome: "credited" as "credited" | "pending",
    paystackRef: null as string | null, // existing paystack ref already processed
    calls: [] as { fn: string; args: any }[],
  }
  const fake = {
    rpc: (fn: string, args: any) => {
      state.calls.push({ fn, args })
      if (fn === "activate_sms_account") {
        if (state.activationRpcError === "ALREADY_ACTIVATED") {
          return Promise.resolve({ data: null, error: { message: "ALREADY_ACTIVATED", code: "P0001" } })
        }
        if (state.activationRpcError === "INSUFFICIENT_BALANCE") {
          return Promise.resolve({ data: null, error: { message: "INSUFFICIENT_BALANCE", code: "P0001" } })
        }
        state.accountStatus = "active"
        return Promise.resolve({ data: [{ ok: true }], error: null })
      }
      if (fn === "claim_sms_welcome_bonus") {
        if (state.bonusRpcError === "ALREADY_CLAIMED") {
          return Promise.resolve({ data: null, error: { message: "ALREADY_CLAIMED", code: "P0001" } })
        }
        return Promise.resolve({ data: [{ units_credited: state.welcomeBonus, outcome: state.creditOutcome }], error: null })
      }
      if (fn === "deduct_wallet") {
        if (state.walletBalance >= args.p_amount) {
          state.walletBalance -= args.p_amount
          return Promise.resolve({ data: [{ new_balance: state.walletBalance }], error: null })
        }
        return Promise.resolve({ data: [], error: null }) // insufficient
      }
      if (fn === "credit_sms_units_if_solvent") {
        return Promise.resolve({ data: [{ outcome: state.creditOutcome }], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => ({
      select: (cols?: string) => ({
        eq: (col: string, val: any) => ({
          single: () => {
            if (table === "sms_accounts") {
              return Promise.resolve({
                data: { id: "acc1", status: state.accountStatus, owner_type: state.ownerType },
                error: null,
              })
            }
            if (table === "users") {
              return Promise.resolve({ data: { email: "test@example.com" }, error: null })
            }
            return Promise.resolve({ data: null, error: null })
          },
          maybeSingle: () => {
            if (table === "sms_accounts") {
              return Promise.resolve({
                data: { id: "acc1", status: state.accountStatus, owner_type: state.ownerType },
                error: null,
              })
            }
            return Promise.resolve({ data: null, error: null })
          },
          eq: (col2: string, val2: any) => ({
            maybeSingle: () => {
              // Paystack ref idempotency check
              if (table === "sms_accounts" && state.paystackRef === val2) {
                return Promise.resolve({ data: { id: "acc1", status: "active" }, error: null })
              }
              return Promise.resolve({ data: null, error: null })
            },
          }),
        }),
      }),
    }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "u1", email: "test@example.com" } }, error: null }),
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({ queryMoolreSmsBalance: () => Promise.resolve(h.state.wholesale) }))
vi.mock("./notify", () => ({ notifyAdminSmsShortfall: () => Promise.resolve() }))

import { activateViaWallet, claimWelcomeBonus, finalizeActivationPaystack } from "./activation-service"

beforeEach(() => {
  h.state.calls.length = 0
  h.state.accountStatus = "inactive"
  h.state.ownerType = "shop"
  h.state.walletBalance = 0
  h.state.activationRpcError = null
  h.state.bonusRpcError = null
  h.state.creditOutcome = "credited"
  h.state.paystackRef = null
})

const rpcs = () => h.state.calls.filter((c) => "fn" in c).map((c) => c.fn)

describe("activateViaWallet", () => {
  it("sufficient wallet → activates and returns ok", async () => {
    h.state.walletBalance = 50
    const res = await activateViaWallet("u1", "acc1")
    expect(res.ok).toBe(true)
    expect(rpcs()).toContain("deduct_wallet")
    expect(rpcs()).toContain("activate_sms_account")
  })

  it("insufficient wallet → NOT_ACTIVATED error, no RPC called", async () => {
    h.state.walletBalance = 5
    const res = await activateViaWallet("u1", "acc1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("INSUFFICIENT_BALANCE")
    expect(rpcs()).not.toContain("activate_sms_account")
  })

  it("already activated → ALREADY_ACTIVATED error", async () => {
    h.state.walletBalance = 50
    h.state.activationRpcError = "ALREADY_ACTIVATED"
    const res = await activateViaWallet("u1", "acc1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("ALREADY_ACTIVATED")
  })

  it("platform account → skips wallet debit, returns ok without gate", async () => {
    h.state.ownerType = "platform"
    h.state.walletBalance = 0
    const res = await activateViaWallet("u1", "acc1")
    // Platform accounts are pre-active; activation is a no-op
    expect(res.ok).toBe(true)
    expect(rpcs()).not.toContain("deduct_wallet")
  })
})

describe("finalizeActivationPaystack", () => {
  it("new reference → calls activate_sms_account RPC", async () => {
    const res = await finalizeActivationPaystack("acc1", "ps-ref-123", 20)
    expect(res.ok).toBe(true)
    expect(rpcs()).toContain("activate_sms_account")
  })

  it("duplicate reference (account already active) → returns ok, alreadyDone=true", async () => {
    h.state.accountStatus = "active"
    h.state.activationRpcError = "ALREADY_ACTIVATED"
    const res = await finalizeActivationPaystack("acc1", "ps-ref-dup", 20)
    expect(res.ok).toBe(true)
    expect(res.alreadyDone).toBe(true)
  })
})

describe("claimWelcomeBonus", () => {
  it("active account, unclaimed → credits bonus and returns ok", async () => {
    h.state.accountStatus = "active"
    const res = await claimWelcomeBonus("acc1")
    expect(res.ok).toBe(true)
    expect(rpcs()).toContain("claim_sms_welcome_bonus")
  })

  it("already claimed → ALREADY_CLAIMED error", async () => {
    h.state.accountStatus = "active"
    h.state.bonusRpcError = "ALREADY_CLAIMED"
    const res = await claimWelcomeBonus("acc1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("ALREADY_CLAIMED")
  })

  it("bonus outcome pending → returns ok with pending=true", async () => {
    h.state.accountStatus = "active"
    h.state.creditOutcome = "pending"
    const res = await claimWelcomeBonus("acc1")
    expect(res.ok).toBe(true)
    expect(res.pending).toBe(true)
  })
})
