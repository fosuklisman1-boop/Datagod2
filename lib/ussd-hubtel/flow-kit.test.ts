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
