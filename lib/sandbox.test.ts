import { describe, it, expect, vi, beforeEach } from "vitest"

// Fake service-role client: records every insert and answers balance reads.
const h = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    insertError: null as null | { code: string },
    balance: 100,
    listResult: { data: [] as unknown, error: null as unknown },
    queries: [] as Array<{ table: string; calls: Array<[string, ...unknown[]]> }>,
  }
  const client = {
    from(table: string) {
      const calls: Array<[string, ...unknown[]]> = []
      state.queries.push({ table, calls })
      const q: any = {}
      q.select = (...a: unknown[]) => {
        calls.push(["select", ...a])
        return q
      }
      q.eq = (...a: unknown[]) => {
        calls.push(["eq", ...a])
        return q
      }
      q.in = (...a: unknown[]) => {
        calls.push(["in", ...a])
        return { then: (res: any, rej: any) => Promise.resolve(state.listResult).then(res, rej) }
      }
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

import { placeSandboxOrder, getSandboxOrdersByReferences } from "./sandbox"

describe("getSandboxOrdersByReferences", () => {
  beforeEach(() => {
    h.state.queries = []
    h.state.listResult = { data: [], error: null }
  })

  it("one owner-scoped query for the batch, status derived like getSandboxOrder", async () => {
    h.state.listResult = {
      data: [
        { reference: "R1", action: "data_order", response: {}, price: 5, resolves_at: "2000-01-01T00:00:00Z", created_at: "t" },
        { reference: "R2", action: "data_order", response: {}, price: 5, resolves_at: "2999-01-01T00:00:00Z", created_at: "t" },
      ],
      error: null,
    }
    const out = await getSandboxOrdersByReferences("u1", ["R1", "R2", "R3"])
    expect(h.state.queries).toHaveLength(1)
    const { table, calls } = h.state.queries[0]
    expect(table).toBe("sandbox_orders")
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    expect(calls).toContainEqual(["in", "reference", ["R1", "R2", "R3"]])
    expect(out!.get("R1")!.status).toBe("completed")
    expect(out!.get("R2")!.status).toBe("pending")
    expect(out!.has("R3")).toBe(false)
  })

  it("returns null on error (caller fails closed) and makes no query for an empty list", async () => {
    h.state.listResult = { data: null, error: { message: "e" } }
    expect(await getSandboxOrdersByReferences("u1", ["R1"])).toBeNull()
    h.state.queries = []
    expect((await getSandboxOrdersByReferences("u1", []))!.size).toBe(0)
    expect(h.state.queries).toHaveLength(0)
  })
})

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
