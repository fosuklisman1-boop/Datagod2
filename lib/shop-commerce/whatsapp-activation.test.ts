import { describe, it, expect } from "vitest"
import { activateWhatsappShop, adminGrantWhatsappShop, adminRevokeWhatsappShop } from "./whatsapp-activation"

// Fake Supabase client for ussd_shop_codes/transactions/ussd_shop_token_purchases +
// the deduct_wallet RPC. Mirrors the makeChain/fakeClient idiom used elsewhere in
// lib/shop-commerce/*.test.ts, extended with a bit of state so the "claim" UPDATE
// can behave like Postgres actually would: a conditional
// `.eq("whatsapp_activated", false)` only matches (and only then flips the flag)
// if the row isn't already activated.
function makeClient(state: { whatsappActivated: boolean; walletBalance: number }) {
  const calls: { table?: string; op: string; payload?: any; args?: any }[] = []

  function updateChain(table: string, payload: any) {
    const eqs: [string, unknown][] = []
    const chain: any = {
      eq: (col: string, val: unknown) => { eqs.push([col, val]); return chain },
      select: () => chain,
      maybeSingle: () => {
        const isConditionalClaimFalse = eqs.some(([c, v]) => c === "whatsapp_activated" && v === false)
        const isConditionalClaimTrue = eqs.some(([c, v]) => c === "whatsapp_activated" && v === true)
        if (isConditionalClaimFalse) {
          if (state.whatsappActivated) {
            // Row already activated (by an earlier winner, or already active) —
            // the conditional UPDATE matches zero rows.
            return Promise.resolve({ data: null, error: null })
          }
          state.whatsappActivated = true
          const idFilter = eqs.find(([c]) => c === "id")
          return Promise.resolve({ data: { id: idFilter?.[1] ?? "sc1" }, error: null })
        }
        if (isConditionalClaimTrue) {
          if (!state.whatsappActivated) {
            // Row is not currently activated — the conditional UPDATE matches zero rows.
            return Promise.resolve({ data: null, error: null })
          }
          state.whatsappActivated = false
          const idFilter = eqs.find(([c]) => c === "id")
          return Promise.resolve({ data: { id: idFilter?.[1] ?? "sc1" }, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      // Unconditional update (the rollback path — no whatsapp_activated filter,
      // just `.eq("id", ...)`), awaited directly without `.select()/.maybeSingle()`.
      then: (resolve: any, reject: any) => {
        if (payload.whatsapp_activated === false) {
          state.whatsappActivated = false
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject)
      },
    }
    return chain
  }

  const client = {
    from: (table: string) => {
      if (table === "ussd_shop_codes") {
        return {
          update: (payload: any) => {
            calls.push({ table, op: "update", payload })
            return updateChain(table, payload)
          },
        }
      }
      if (table === "transactions" || table === "ussd_shop_token_purchases") {
        return {
          insert: (payload: any) => {
            calls.push({ table, op: "insert", payload })
            return Promise.resolve({ data: null, error: null })
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
    rpc: (fn: string, args: any) => {
      calls.push({ op: "rpc", args: { fn, ...args } })
      if (fn === "deduct_wallet") {
        if (state.walletBalance >= args.p_amount) {
          const oldBalance = state.walletBalance
          state.walletBalance -= args.p_amount
          return Promise.resolve({ data: [{ new_balance: state.walletBalance, old_balance: oldBalance }], error: null })
        }
        return Promise.resolve({ data: [], error: null }) // insufficient — RPC returns no rows
      }
      return Promise.resolve({ data: null, error: null })
    },
  } as any

  return { client, calls }
}

const baseInput = { shopCodeId: "sc1", shopId: "s1", userId: "u1", fee: 20 }

describe("activateWhatsappShop", () => {
  it("claims, deducts the wallet, and records the purchase on a clean single call", async () => {
    const { client, calls } = makeClient({ whatsappActivated: false, walletBalance: 50 })

    const result = await activateWhatsappShop(baseInput, client)

    expect(result).toEqual({ ok: true })
    expect(calls.filter(c => c.op === "rpc" && c.args.fn === "deduct_wallet")).toHaveLength(1)
    const purchaseInsert = calls.find(c => c.table === "ussd_shop_token_purchases")
    expect(purchaseInsert?.payload[0]).toMatchObject({
      shop_code_id: "sc1",
      shop_id: "s1",
      tokens_purchased: 0,
      amount_paid: 20,
      is_whatsapp_activation: true,
      payment_status: "completed",
    })
  })

  it("two concurrent requests: the first wins the claim and charges once; the second gets 409 with the wallet never touched for it", async () => {
    const state = { whatsappActivated: false, walletBalance: 100 }
    const { client, calls } = makeClient(state)

    // Simulate the race: both requests read "not yet activated" and reach the
    // claim UPDATE before either committed. We model that by calling
    // activateWhatsappShop twice against the SAME shared `state` — the second
    // call's conditional UPDATE only matches if the first hasn't already won,
    // exactly like Postgres would serialize two concurrent UPDATEs on one row.
    const [first, second] = await Promise.all([
      activateWhatsappShop(baseInput, client),
      activateWhatsappShop(baseInput, client),
    ])

    const results = [first, second]
    const winners = results.filter(r => r.ok)
    const losers = results.filter(r => !r.ok)

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ ok: false, status: 409, error: "Already activated" })

    // Exactly one deduct_wallet call — the loser never touched the wallet.
    const deductCalls = calls.filter(c => c.op === "rpc" && c.args.fn === "deduct_wallet")
    expect(deductCalls).toHaveLength(1)
    expect(state.walletBalance).toBe(80) // charged exactly once (100 - fee(20))
  })

  it("sequential double-activation (first call fully completes, then a second call arrives) is also rejected with no second charge", async () => {
    const state = { whatsappActivated: false, walletBalance: 100 }
    const { client, calls } = makeClient(state)

    const first = await activateWhatsappShop(baseInput, client)
    expect(first).toEqual({ ok: true })

    const second = await activateWhatsappShop(baseInput, client)
    expect(second).toMatchObject({ ok: false, status: 409, error: "Already activated" })

    const deductCalls = calls.filter(c => c.op === "rpc" && c.args.fn === "deduct_wallet")
    expect(deductCalls).toHaveLength(1)
    expect(state.walletBalance).toBe(80)
  })

  it("rolls back the claim (whatsapp_activated back to false) when the wallet deduction fails, and never touches transactions/purchase rows", async () => {
    const { client, calls } = makeClient({ whatsappActivated: false, walletBalance: 5 }) // < fee(20)

    const result = await activateWhatsappShop(baseInput, client)

    expect(result).toEqual({ ok: false, status: 402, error: "Insufficient wallet balance" })

    // Claim update, then rollback update — two ussd_shop_codes updates, no charge rows.
    const codeUpdates = calls.filter(c => c.table === "ussd_shop_codes" && c.op === "update")
    expect(codeUpdates).toHaveLength(2)
    expect(codeUpdates[0].payload).toMatchObject({ whatsapp_activated: true })
    expect(codeUpdates[1].payload).toMatchObject({ whatsapp_activated: false, whatsapp_activated_at: null })

    expect(calls.some(c => c.table === "transactions")).toBe(false)
    expect(calls.some(c => c.table === "ussd_shop_token_purchases")).toBe(false)

    // A retry after the rollback must be able to claim again (proves the flag
    // really went back to false, not just that the payload looked right).
    const retry = await activateWhatsappShop({ ...baseInput, fee: 5 }, client)
    expect(retry).toEqual({ ok: true })
  })
})

describe("adminGrantWhatsappShop", () => {
  it("claims and records a manual (zero-fee) purchase row on a clean call", async () => {
    const { client, calls } = makeClient({ whatsappActivated: false, walletBalance: 0 })

    const result = await adminGrantWhatsappShop({ shopCodeId: "sc1", shopId: "s1" }, client)

    expect(result).toEqual({ ok: true })
    // No wallet deduction — this is an admin-granted activation, not a paid one.
    expect(calls.some(c => c.op === "rpc" && c.args?.fn === "deduct_wallet")).toBe(false)
    const purchaseInsert = calls.find(c => c.table === "ussd_shop_token_purchases")
    expect(purchaseInsert?.payload[0]).toMatchObject({
      shop_code_id: "sc1",
      shop_id: "s1",
      tokens_purchased: 0,
      amount_paid: 0,
      payment_method: "manual",
      payment_status: "completed",
      is_whatsapp_activation: true,
    })
  })

  it("rejects with 409 when already activated, and logs no purchase row", async () => {
    const { client, calls } = makeClient({ whatsappActivated: true, walletBalance: 0 })

    const result = await adminGrantWhatsappShop({ shopCodeId: "sc1", shopId: "s1" }, client)

    expect(result).toEqual({ ok: false, status: 409, error: "Already activated" })
    expect(calls.some(c => c.table === "ussd_shop_token_purchases")).toBe(false)
  })

  it("two concurrent grants: only one wins the claim and logs exactly one purchase row", async () => {
    const state = { whatsappActivated: false, walletBalance: 0 }
    const { client, calls } = makeClient(state)

    const [first, second] = await Promise.all([
      adminGrantWhatsappShop({ shopCodeId: "sc1", shopId: "s1" }, client),
      adminGrantWhatsappShop({ shopCodeId: "sc1", shopId: "s1" }, client),
    ])

    const winners = [first, second].filter(r => r.ok)
    const losers = [first, second].filter(r => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ ok: false, status: 409 })
    expect(calls.filter(c => c.table === "ussd_shop_token_purchases")).toHaveLength(1)
  })
})

describe("adminRevokeWhatsappShop", () => {
  it("clears whatsapp_activated and whatsapp_activated_at on a clean call", async () => {
    const { client, calls } = makeClient({ whatsappActivated: true, walletBalance: 0 })

    const result = await adminRevokeWhatsappShop({ shopCodeId: "sc1" }, client)

    expect(result).toEqual({ ok: true })
    const update = calls.find(c => c.table === "ussd_shop_codes" && c.op === "update")
    expect(update?.payload).toMatchObject({ whatsapp_activated: false, whatsapp_activated_at: null })
    // No purchase/transaction rows touched by a revoke.
    expect(calls.some(c => c.table === "ussd_shop_token_purchases")).toBe(false)
    expect(calls.some(c => c.table === "transactions")).toBe(false)
  })

  it("rejects with 409 when not currently activated", async () => {
    const { client } = makeClient({ whatsappActivated: false, walletBalance: 0 })

    const result = await adminRevokeWhatsappShop({ shopCodeId: "sc1" }, client)

    expect(result).toEqual({ ok: false, status: 409, error: "Not currently activated" })
  })

  it("two concurrent revokes: only one wins the claim", async () => {
    const state = { whatsappActivated: true, walletBalance: 0 }
    const { client } = makeClient(state)

    const [first, second] = await Promise.all([
      adminRevokeWhatsappShop({ shopCodeId: "sc1" }, client),
      adminRevokeWhatsappShop({ shopCodeId: "sc1" }, client),
    ])

    const winners = [first, second].filter(r => r.ok)
    const losers = [first, second].filter(r => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ ok: false, status: 409 })
  })
})
