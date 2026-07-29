import { describe, it, expect } from "vitest"
import { claimUssdShopOrderPaid } from "./claim-order-paid"

// Fake Supabase client for the conditional UPDATE. Mirrors the shared-state
// concurrency idiom from whatsapp-activation.test.ts's updateChain: the
// `.in("payment_status", [...])` filter only matches (and only then flips the
// status) while the row is still in a pre-paid state — exactly like Postgres
// would serialize two concurrent UPDATEs racing on the same row.
function updateChain(payload: any, state: { paymentStatus: string }) {
  const eqs: [string, unknown][] = []
  let inFilter: unknown[] | null = null
  const chain: any = {
    eq: (col: string, val: unknown) => { eqs.push([col, val]); return chain },
    in: (col: string, vals: unknown[]) => { if (col === "payment_status") inFilter = vals; return chain },
    select: () => chain,
    maybeSingle: () => {
      const matches = !inFilter || inFilter.includes(state.paymentStatus)
      if (!matches) return Promise.resolve({ data: null, error: null })
      state.paymentStatus = payload.payment_status
      const idFilter = eqs.find(([c]) => c === "id")
      return Promise.resolve({ data: { id: idFilter?.[1] ?? "order1" }, error: null })
    },
  }
  return chain
}

function makeClient(state: { paymentStatus: string }) {
  const calls: { op: string; payload?: any }[] = []
  const client = {
    from: (table: string) => {
      if (table !== "ussd_shop_orders") throw new Error(`Unexpected table: ${table}`)
      return {
        update: (payload: any) => {
          calls.push({ op: "update", payload })
          return updateChain(payload, state)
        },
      }
    },
  } as any
  return { client, calls }
}

function makeErrorClient(message: string) {
  return {
    from: () => ({
      update: () => {
        const chain: any = {
          eq: () => chain,
          in: () => chain,
          select: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: { message } }),
        }
        return chain
      },
    }),
  } as any
}

describe("claimUssdShopOrderPaid", () => {
  it("claims a pending order and marks it completed", async () => {
    const state = { paymentStatus: "pending" }
    const { client } = makeClient(state)

    const result = await claimUssdShopOrderPaid("order1", "ref1", client)

    expect(result).toEqual({ claimed: true })
    expect(state.paymentStatus).toBe("completed")
  })

  it("claims an otp_required order too (matches the read-side guard's two valid pre-states)", async () => {
    const state = { paymentStatus: "otp_required" }
    const { client } = makeClient(state)

    const result = await claimUssdShopOrderPaid("order1", "ref1", client)

    expect(result).toEqual({ claimed: true })
  })

  it("two concurrent webhook deliveries for the same order: only one claims — the loser gets claimed:false and never re-transitions the row", async () => {
    const state = { paymentStatus: "pending" }
    const { client } = makeClient(state)

    const [first, second] = await Promise.all([
      claimUssdShopOrderPaid("order1", "ref1", client),
      claimUssdShopOrderPaid("order1", "ref1", client),
    ])

    const results = [first, second]
    expect(results.filter(r => r.claimed)).toHaveLength(1)
    expect(results.filter(r => !r.claimed)).toHaveLength(1)
    expect(state.paymentStatus).toBe("completed")
  })

  it("sequential retry (first call fully completes, then a second delivery arrives) also does not re-claim", async () => {
    const state = { paymentStatus: "pending" }
    const { client } = makeClient(state)

    const first = await claimUssdShopOrderPaid("order1", "ref1", client)
    expect(first).toEqual({ claimed: true })

    const second = await claimUssdShopOrderPaid("order1", "ref1", client)
    expect(second).toEqual({ claimed: false })
  })

  it("does not claim an order that's already completed", async () => {
    const state = { paymentStatus: "completed" }
    const { client } = makeClient(state)

    const result = await claimUssdShopOrderPaid("order1", "ref1", client)

    expect(result).toEqual({ claimed: false })
  })

  it("surfaces a DB error without throwing", async () => {
    const client = makeErrorClient("db down")

    const result = await claimUssdShopOrderPaid("order1", "ref1", client)

    expect(result).toEqual({ claimed: false, error: "db down" })
  })
})
