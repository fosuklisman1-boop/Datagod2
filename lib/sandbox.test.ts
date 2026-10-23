import { describe, it, expect, vi, beforeEach } from "vitest"

// Fake service-role client: records every insert and answers balance reads.
const h = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    insertError: null as null | { code: string },
    balance: 100,
  }
  const client = {
    from(table: string) {
      const q: any = {}
      q.select = () => q
      q.eq = () => q
      q.update = () => q
      q.maybeSingle = async () => ({ data: table === "sandbox_wallets" ? { balance: state.balance } : null, error: null })
      q.single = q.maybeSingle
      q.insert = async (row: Record<string, unknown>) => {
        state.inserts.push({ table, row })
        return { error: state.insertError }
      }
      q.then = (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej)
      return q
    },
  }
  return { state, client }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.client }))

import { placeSandboxOrder } from "./sandbox"

const base = {
  userId: "u1",
  action: "data_order" as const,
  reference: "SBX-1",
  request: { network: "MTN" },
  price: 5,
  orderFields: { network: "MTN", volume_gb: 1, price: 5, recipient: "0249990401" },
}

describe("placeSandboxOrder key attribution", () => {
  beforeEach(() => {
    h.state.inserts = []
    h.state.insertError = null
    h.state.balance = 100
  })

  it("v1 callers insert exactly as before (api_key_id, no api_v2_key_id)", async () => {
    const r = await placeSandboxOrder({ ...base, apiKeyId: "v1key" })
    expect(r.success).toBe(true)
    const ins = h.state.inserts.find((i) => i.table === "sandbox_orders")!.row
    expect(Object.keys(ins)).toEqual([
      "user_id",
      "api_key_id",
      "action",
      "reference",
      "request",
      "response",
      "price",
      "resolves_at",
    ])
    expect(ins.api_key_id).toBe("v1key")
  })

  it("v2 callers insert api_v2_key_id and leave api_key_id null", async () => {
    const r = await placeSandboxOrder({ ...base, apiV2KeyId: "v2key" })
    expect(r.success).toBe(true)
    const ins = h.state.inserts.find((i) => i.table === "sandbox_orders")!.row
    expect(ins.api_v2_key_id).toBe("v2key")
    expect(ins.api_key_id).toBeNull()
  })

  it("refuses a call with no key at all, before touching the sandbox wallet or orders", async () => {
    const r = await placeSandboxOrder({ ...base })
    expect(r).toEqual({ success: false, error: "Failed to place sandbox order", status: 500 })
    expect(h.state.inserts).toEqual([])
  })

  it("duplicate reference still maps to 409", async () => {
    h.state.insertError = { code: "23505" }
    const r = await placeSandboxOrder({ ...base, apiV2KeyId: "v2key" })
    expect(r).toEqual({ success: false, error: "Duplicate reference", status: 409 })
  })
})
