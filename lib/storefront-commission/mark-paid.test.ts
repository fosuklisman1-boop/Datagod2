import { describe, it, expect } from "vitest"
import { markCommissionOrderPaid, markCommissionOrderPaidRow } from "./mark-paid"

type Row = Record<string, any>

/** Minimal filter-aware fake: update(...).eq/in(...).select() over one in-memory table. */
function fakeDb(rows: Row[]) {
  const calls: unknown[][] = []
  const client: any = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      let patch: Row = {}
      const q: any = {
        update: (p: Row) => { patch = p; calls.push([table, "update", p]); return q },
        eq: (c: string, v: unknown) => { calls.push([table, "eq", c, v]); filters.push(r => r[c] === v); return q },
        in: (c: string, vs: unknown[]) => { calls.push([table, "in", c, vs]); filters.push(r => vs.includes(r[c])); return q },
        select: async () => {
          const hit = rows.filter(r => filters.every(f => f(r)))
          for (const r of hit) Object.assign(r, patch)
          return { data: hit.map(r => ({ id: r.id, status: r.status })), error: null }
        },
      }
      return q
    },
  }
  return { client, calls }
}

const PATCH = { paid_at: "2026-10-15T00:00:00Z", payment_reference: "H1" }

describe("markCommissionOrderPaidRow (the flip's own row state)", () => {
  it("returns rows changed and the status the flipped row has (no re-read); a no-op flip => 0 / null", async () => {
    const rows: Row[] = [{ id: "o1", channel: "bots", payment_status: "unpaid", status: "failed" }]
    const { client } = fakeDb(rows)
    expect(await markCommissionOrderPaidRow(client, "hubtel_data_orders", "o1", PATCH)).toEqual({ changed: 1, status: "failed" })
    expect(await markCommissionOrderPaidRow(client, "hubtel_data_orders", "o1", PATCH)).toEqual({ changed: 0, status: null })
  })
})

describe("markCommissionOrderPaid", () => {
  it("flips an unpaid commission row once; a second call is a no-op", async () => {
    const rows: Row[] = [{ id: "o1", channel: "bots", payment_status: "unpaid", status: "pending" }]
    const { client } = fakeDb(rows)
    expect(await markCommissionOrderPaid(client, "hubtel_data_orders", "o1", PATCH)).toBe(1)
    expect(rows[0]).toMatchObject({ payment_status: "paid", payment_reference: "H1", paid_at: PATCH.paid_at, status: "pending" })
    expect(await markCommissionOrderPaid(client, "hubtel_data_orders", "o1", { ...PATCH, payment_reference: "H2" })).toBe(0)
    expect(rows[0].payment_reference).toBe("H1")
  })

  it("extra columns go into the same guarded update but never override payment_status", async () => {
    const rows = [{ id: "o1", channel: "bots", payment_status: "unpaid", status: "pending" }]
    const { client } = fakeDb(rows)
    await markCommissionOrderPaid(client, "hubtel_bill_orders", "o1", PATCH, {
      extra: { status: "failed", failure_reason: "needs review: x", payment_status: "unpaid" }, channels: ["bots"],
    })
    expect(rows[0]).toMatchObject({ payment_status: "paid", status: "failed", failure_reason: "needs review: x" })
  })

  it("channel guard: a dashboard row is never flipped; channels narrows the guard", async () => {
    const rows = [
      { id: "o1", channel: "dashboard", payment_status: "unpaid" },
      { id: "o2", channel: "storefront", payment_status: "unpaid" },
    ]
    const { client } = fakeDb(rows)
    expect(await markCommissionOrderPaid(client, "hubtel_bill_orders", "o1", PATCH)).toBe(0)
    expect(await markCommissionOrderPaid(client, "hubtel_bill_orders", "o2", PATCH, { channels: ["bots"] })).toBe(0)
    expect(rows.every(r => r.payment_status === "unpaid")).toBe(true)
    expect(await markCommissionOrderPaid(client, "hubtel_bill_orders", "o2", PATCH)).toBe(1)
  })
})
