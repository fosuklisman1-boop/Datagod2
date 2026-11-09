// lib/storefront-commission/confirm-runtime.queued.test.ts
// confirmBotPaymentQueued: the real engine and the real deps wiring, with the Hubtel send replaced by a queue.
import { describe, it, expect, vi } from "vitest"

type Row = Record<string, any>
const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, any>>,
  profits: [] as Record<string, any>[],
  posts: [] as string[],
}))

function fakeDb() {
  return {
    from(table: string) {
      const eqs: Record<string, unknown> = {}
      let patch: Row | null = null
      const row = () => h.rows[String(eqs.id)]
      const q: any = {
        select: () => q,
        update: (p: Row) => { patch = p; return q },
        insert: async (r: Row[]) => {
          if (h.profits.some(p => p.data_order_id === r[0].data_order_id)) return { error: { code: "23505" } }
          h.profits.push(r[0])
          return { error: null }
        },
        eq: (c: string, v: unknown) => { eqs[c] = v; return q },
        in: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: row() ? { ...row() } : null, error: null }),
        then: (res: any) => {
          if (table === "hubtel_cs_transactions") return res({ count: 0, error: null })
          const r = row()
          const hit = patch && r && (eqs.payment_status === undefined || r.payment_status === eqs.payment_status)
          if (hit) Object.assign(r, patch)
          return res({ data: hit ? [{ id: r.id, status: r.status }] : [], error: null })
        },
      }
      return q
    },
  }
}

vi.mock("@/lib/bills/runtime", () => ({ getBillsRuntime: () => ({ db: fakeDb(), deps: { alert: async () => {} } }) }))
vi.mock("@/lib/standard-bundles/runtime", () => ({
  getBundlesRuntime: () => ({ deps: { getOrder: async (id: string) => { h.posts.push(id); return null } } }),
}))
vi.mock("@/lib/paystack", () => ({ verifyPayment: vi.fn() }))

import { confirmBotPaymentQueued } from "./confirm-runtime"

const order = (o: Row = {}): Row => ({
  id: "c1", reference_code: "SB-1", channel: "bots", shop_id: "shop1", status: "pending", payment_status: "unpaid",
  paid_amount: 5.07, shop_share_amount: 0.15, payment_reference: null, hubtel_client_reference: null, notes: null, created_at: "", ...o,
})
const P = { paidAmount: 5.07, reference: "H1" }

describe("confirmBotPaymentQueued", () => {
  it("flips, credits the share and queues the id; nothing is sent", async () => {
    h.rows = { c1: order() }; h.profits = []; h.posts = []
    const queue: string[] = []
    expect(await confirmBotPaymentQueued("hubtel_data_orders", "c1", P, queue)).toEqual({ outcome: "confirmed", status: "pending" })
    expect(queue).toEqual(["c1"])
    expect(h.rows.c1).toMatchObject({ payment_status: "paid", payment_reference: "H1" })
    expect(h.profits).toEqual([expect.objectContaining({ data_order_id: "c1", profit_amount: 0.15 })])
    expect(h.posts).toEqual([])
  })

  it("a child already sent is not queued; one paid by this payment but never sent is resumed and queued, without a second share", async () => {
    h.rows = { c1: order({ payment_status: "paid", payment_reference: "H1", status: "processing", hubtel_client_reference: "HCS" }) }; h.profits = []; h.posts = []
    const sent: string[] = []
    expect((await confirmBotPaymentQueued("hubtel_data_orders", "c1", P, sent)).outcome).toBe("already_processed")
    expect(sent).toEqual([])

    h.rows = { c1: order({ payment_status: "paid", payment_reference: "H1" }) }
    h.profits = [{ data_order_id: "c1" }]
    const stranded: string[] = []
    expect((await confirmBotPaymentQueued("hubtel_data_orders", "c1", P, stranded)).outcome).toBe("resumed")
    expect(stranded).toEqual(["c1"])
    expect(h.profits).toHaveLength(1)
    expect(h.posts).toEqual([])
  })

  it("a wrong amount queues nothing", async () => {
    h.rows = { c1: order() }; h.profits = []; h.posts = []
    const queue: string[] = []
    expect((await confirmBotPaymentQueued("hubtel_data_orders", "c1", { paidAmount: 15.21, reference: "H1" }, queue)).outcome).toBe("amount_mismatch")
    expect(queue).toEqual([])
    expect(h.rows.c1.payment_status).toBe("unpaid")
  })
})
