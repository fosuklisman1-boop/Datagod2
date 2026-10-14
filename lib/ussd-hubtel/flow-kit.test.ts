// lib/ussd-hubtel/flow-kit.test.ts
// I3: submitOrder must never log the raw PostgREST error (details carry the whole customer row).
import { describe, it, expect, vi } from "vitest"
import { submitOrder, type FlowCtx } from "./flow-kit"
import { makeDeps, req } from "./testing/fakes"

const PII_ERROR = {
  code: "23502",
  message: 'null value in column "region" of relation "ussd_afa_orders" violates not-null constraint',
  details: "Failing row contains (a1, Kwame Mensah, GHA-123456789-0, 0244123456, null).",
  hint: "hint text",
}

function ctxWith(client: unknown): FlowCtx {
  const { deps } = makeDeps({ supabase: client as never })
  return {
    input: "1", req: req({}), deps,
    config: { enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } } as never,
    session: { step: "AFA_CONFIRM", dialingPhone: "+233244123456", platform: "USSD" },
  }
}

const row = { full_name: "Kwame Mensah", ghana_card: "GHA-123456789-0" }

/** Records every write: inserts per table, updates with their eq/in filters. */
function recordingClient(opts: { txError?: { code?: string; message: string }; txRow?: unknown } = {}) {
  const inserts: Record<string, any[]> = {}
  const updates: { table: string; patch: any; filters: string[] }[] = []
  const client = {
    from(table: string) {
      return {
        insert(rows: any) {
          ;(inserts[table] ??= []).push(...([] as any[]).concat(rows))
          const err = table === "hubtel_transactions" ? opts.txError ?? null : null
          return {
            select: () => ({ single: async () => ({ data: { id: "new-order" }, error: null }) }),
            then: (res: any) => res({ error: err }),
          }
        },
        update(patch: any) {
          const u = { table, patch, filters: [] as string[] }
          updates.push(u)
          const q: any = {
            eq: (c: string, v: string) => (u.filters.push(`${c}=${v}`), q),
            in: (c: string, v: string[]) => (u.filters.push(`${c} in ${v.join("|")}`), q),
            then: (res: any) => res({ error: null }),
          }
          return q
        },
        select() {
          const q: any = { eq: () => q, maybeSingle: async () => ({ data: opts.txRow ?? null, error: null }), single: async () => ({ data: { id: "bot-1" }, error: null }) }
          return q
        },
      }
    },
  }
  return { client, inserts, updates }
}

describe("submitOrder with an engine-created order (orderId)", () => {
  it("writes no order, only the tx row, and carts at price under the opaque name", async () => {
    const rec = recordingClient()
    const reply = await submitOrder(ctxWith(rec.client), { table: "hubtel_data_orders", orderId: "bot-1", price: 9.5, logTag: "T" })
    expect(rec.inserts.hubtel_data_orders).toBeUndefined()
    expect(rec.inserts.hubtel_transactions).toEqual([{
      session_id: "S1", platform: "USSD", order_table: "hubtel_data_orders", order_id: "bot-1", mobile: "+233244123456", expected_amount: 9.5,
    }])
    expect(reply.Type).toBe("AddToCart")
    expect(reply.Item).toEqual({ ItemName: "CH order bot1", Qty: 1, Price: 9.5 })
  })

  it("tx insert failure: fail patch on the bot order, guarded to open bot rows", async () => {
    const rec = recordingClient({ txError: { message: "boom" } })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const reply = await submitOrder(ctxWith(rec.client), { table: "hubtel_data_orders", orderId: "bot-1", price: 9.5, logTag: "T" })
    vi.restoreAllMocks()
    expect(reply.Type).toBe("release")
    expect(rec.updates).toHaveLength(1)
    expect(rec.updates[0].patch).toMatchObject({ status: "failed", failure_reason: "payment not completed" })
    expect(rec.updates[0].filters).toEqual(["id=bot-1", "channel in bots", "status in pending"])
  })

  it("unique violation (a concurrent CONFIRM won with the same order): never fails the shared order, replays", async () => {
    const rec = recordingClient({
      txError: { code: "23505", message: "dup" },
      txRow: { order_table: "hubtel_data_orders", order_id: "bot-1", expected_amount: 9.5, state: "awaiting_payment" },
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const reply = await submitOrder(ctxWith(rec.client), { table: "hubtel_data_orders", orderId: "bot-1", price: 9.5, logTag: "T" })
    vi.restoreAllMocks()
    expect(rec.updates).toHaveLength(0)
    expect(reply.Type).toBe("AddToCart")
    expect(reply.Item?.Price).toBe(9.5)
  })

  it("non-positive price: no tx row, the engine order is failed", async () => {
    const rec = recordingClient()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const reply = await submitOrder(ctxWith(rec.client), { table: "hubtel_data_orders", orderId: "bot-1", price: 0, logTag: "T" })
    vi.restoreAllMocks()
    expect(reply.Type).toBe("release")
    expect(rec.inserts.hubtel_transactions).toBeUndefined()
    expect(rec.updates[0].filters[0]).toBe("id=bot-1")
  })
})

describe("submitOrder existing callers (row) unchanged", () => {
  it("inserts the row, then the tx row, carts at price", async () => {
    const rec = recordingClient()
    const reply = await submitOrder(ctxWith(rec.client), { table: "ussd_afa_orders", row, price: 50, logTag: "T" })
    expect(rec.inserts.ussd_afa_orders).toEqual([row])
    expect(rec.inserts.hubtel_transactions[0]).toMatchObject({ order_table: "ussd_afa_orders", order_id: "new-order", expected_amount: 50 })
    expect(reply.Item).toEqual({ ItemName: "CH order neworder", Qty: 1, Price: 50 })
  })
  it("tx failure: fail patch by id only (no guards on legacy tables)", async () => {
    const rec = recordingClient({ txError: { message: "boom" } })
    vi.spyOn(console, "error").mockImplementation(() => {})
    await submitOrder(ctxWith(rec.client), { table: "ussd_afa_orders", row, price: 50, logTag: "T" })
    vi.restoreAllMocks()
    expect(rec.updates).toEqual([{ table: "ussd_afa_orders", patch: expect.objectContaining({ order_status: "failed", payment_status: "failed" }), filters: ["id=new-order"] }])
  })
  it("unique violation on a freshly inserted order: still fails it, then replays the winner", async () => {
    const rec = recordingClient({
      txError: { code: "23505", message: "dup" },
      txRow: { order_table: "ussd_afa_orders", order_id: "winner", expected_amount: 50, state: "awaiting_payment" },
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const reply = await submitOrder(ctxWith(rec.client), { table: "ussd_afa_orders", row, price: 50, logTag: "T" })
    vi.restoreAllMocks()
    expect(rec.updates.map(u => u.filters)).toEqual([["id=new-order"]])
    expect(reply.Item?.ItemName).toBe("CH order winner")
  })
})

describe("submitOrder error logging (I3)", () => {
  it("order insert failure logs code + message only, no row details", async () => {
    const client = {
      from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: PII_ERROR }) }) }) }),
    }
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const reply = await submitOrder(ctxWith(client), { table: "ussd_afa_orders", row, price: 50, logTag: "T" })
    const logged = JSON.stringify(err.mock.calls)
    err.mockRestore()
    expect(reply.Type).toBe("release")
    expect(logged).toContain("23502")
    expect(logged).not.toMatch(/Kwame|GHA-|0244123456|Failing row|hint text/)
  })

  it("tx insert failure + rollback failure log no row details", async () => {
    const client = {
      from: (table: string) => table === "hubtel_transactions"
        ? { insert: () => ({ then: (res: any) => res({ error: PII_ERROR }) }) }
        : {
            insert: () => ({ select: () => ({ single: async () => ({ data: { id: "o1" }, error: null }) }) }),
            update: () => ({ eq: () => ({ then: (res: any) => res({ error: PII_ERROR }) }) }),
          },
    }
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await submitOrder(ctxWith(client), { table: "ussd_afa_orders", row, price: 50, logTag: "T" })
    const logged = JSON.stringify(err.mock.calls)
    const n = err.mock.calls.length
    err.mockRestore()
    expect(n).toBeGreaterThanOrEqual(2)
    expect(logged).not.toMatch(/Kwame|GHA-|0244123456|Failing row|hint text/)
  })
})
