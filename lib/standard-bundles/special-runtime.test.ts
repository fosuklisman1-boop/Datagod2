import { describe, it, expect } from "vitest"
import { buildSpecialDeps } from "./special-runtime"
import type { BundlesDeps } from "./service"

const ARGS = {
  userId: "u1", groupKey: "0f8fad5b-d9cb-469f-a165-70867728950e", n: 2, total: 6,
  rows: [1, 2].map(() => ({
    network: "MTN" as const, service_key: "data_mtn", beneficiary_phone: "233244123456", bundle_value: "V",
    bundle_display: "406.89MB", bundle_category: "Data", amount: 3, paid_amount: 3,
  })),
}

function fakeDb(rpcResult: { data?: unknown; error?: unknown }, rows: unknown[] = []) {
  const seen = { rpc: [] as any[], filters: [] as any[] }
  const db: any = {
    rpc: async (name: string, params: unknown) => { seen.rpc.push([name, params]); return { data: rpcResult.data ?? null, error: rpcResult.error ?? null } },
    from: (t: string) => {
      const q: any = {
        select: (c: string) => { seen.filters.push(["select", t, c]); return q },
        eq: (k: string, v: unknown) => { seen.filters.push(["eq", k, v]); return q },
        order: (k: string, o: unknown) => { seen.filters.push(["order", k, o]); return Promise.resolve({ data: rows, error: null }) },
      }
      return q
    },
  }
  return { db, seen }
}
const base = {} as BundlesDeps

describe("buildSpecialDeps", () => {
  it("calls create_special_bundle_orders with exactly the RPC's parameters and maps the result", async () => {
    const { db, seen } = fakeDb({ data: { group_id: "g", order_ids: ["a", "b"], replay: false } })
    const d = buildSpecialDeps(base, db, () => {})
    expect(await d.createSpecialOrders(ARGS)).toEqual({ ok: true, groupId: "g", orderIds: ["a", "b"], replay: false })
    expect(seen.rpc).toEqual([["create_special_bundle_orders", { p_user: "u1", p_group_key: ARGS.groupKey, p_n: 2, p_rows: ARGS.rows, p_total: 6 }]])
  })
  it("INSUFFICIENT_FUNDS / BAD_INPUT are mapped; anything else throws (outcome unknown)", async () => {
    expect(await buildSpecialDeps(base, fakeDb({ error: { message: "INSUFFICIENT_FUNDS", code: "P0001" } }).db, () => {}).createSpecialOrders(ARGS))
      .toEqual({ ok: false, error: "insufficient" })
    expect(await buildSpecialDeps(base, fakeDb({ error: { message: "BAD_INPUT", details: "n must be 1..50", code: "P0001" } }).db, () => {}).createSpecialOrders(ARGS))
      .toEqual({ ok: false, error: "bad_input", detail: "n must be 1..50" })
    await expect(buildSpecialDeps(base, fakeDb({ error: { message: "timeout" } }).db, () => {}).createSpecialOrders(ARGS)).rejects.toThrow()
    await expect(buildSpecialDeps(base, fakeDb({ data: { group_id: "g" } }).db, () => {}).createSpecialOrders(ARGS)).rejects.toThrow()
  })
  it("listSpecialGroup filters by the user AND the group, ordered by special_index", async () => {
    const { db, seen } = fakeDb({}, [{ id: "a" }])
    const d = buildSpecialDeps(base, db, () => {})
    expect(await d.listSpecialGroup("u1", "g")).toEqual([{ id: "a" }])
    expect(seen.filters).toEqual([
      ["select", "hubtel_data_orders", "*"], ["eq", "user_id", "u1"], ["eq", "special_group_id", "g"], ["order", "special_index", { ascending: true }],
    ])
  })
  it("keeps every base dep and wires schedule", () => {
    const tasks: unknown[] = []
    const d = buildSpecialDeps({ secret: "x" } as BundlesDeps, fakeDb({}).db, (t) => { tasks.push(t) })
    expect(d.secret).toBe("x")
    d.schedule(async () => {})
    expect(tasks).toHaveLength(1)
  })
})
