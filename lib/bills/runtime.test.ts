import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/hubtel-cs/runtime", () => ({ getHubtelCsRuntime: vi.fn() }))

import { buildBillsDeps, getBillsAvailability, listUserBillOrders } from "./runtime"

/** Chainable fake: records calls, resolves to `result` when awaited or on terminal methods. */
function fakeDb(result: { data?: any; error?: any }, configValue?: any) {
  const calls: { fn: string; args: any[] }[] = []
  const chain: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (res: any) => res({ data: result.data ?? null, error: result.error ?? null })
      return (...args: any[]) => { calls.push({ fn: prop, args }); return chain }
    },
  })
  const db: any = {
    from: (t: string) => { calls.push({ fn: "from", args: [t] }); return t === "admin_settings" ? cfgChain(configValue) : chain },
    rpc: async (name: string, args: any) => { calls.push({ fn: "rpc", args: [name, args] }); return { data: result.data ?? null, error: result.error ?? null } },
  }
  return { db, calls }
}
const cfgChain = (value: any): any => ({
  select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value === undefined ? null : { value }, error: null }) }) }),
})
const parts = (db: any) => ({ db, getConfig: async () => ({ enabled: true, paused: false, services: {} }), client: { query: vi.fn(), purchase: vi.fn() } as any })
const deps = (db: any) => buildBillsDeps(parts(db), "sek", async () => {})

describe("getBillsAvailability", () => {
  it("returns only enabled billers with display fields when master is on", async () => {
    const { db } = fakeDb({}, {
      enabled: true,
      billers: { ecg: { enabled: true, min: 10, max: 500 }, dstv: { enabled: true, min: 5, max: 1000 }, gotv: { enabled: false, min: 5, max: 1000 } },
    })
    const a = await getBillsAvailability(db)
    expect(a.enabled).toBe(true)
    expect(a.billers.map(b => b.key)).toEqual(["ecg", "dstv"])
    expect(a.billers[0]).toEqual({
      key: "ecg", label: "ECG Prepaid & Postpaid", logo: "/billers/ecg.png", inputHint: "Meter number", page: "bills", min: 10, max: 500,
    })
  })
  it("is disabled with no billers when the master switch is off", async () => {
    const { db } = fakeDb({}, { enabled: false, billers: { ecg: { enabled: true, min: 5, max: 100 } } })
    expect(await getBillsAvailability(db)).toEqual({ enabled: false, billers: [] })
  })
  it("never throws: a config read error fails closed", async () => {
    const db: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: new Error("boom") }) }) }) }) }
    expect(await getBillsAvailability(db)).toEqual({ enabled: false, billers: [] })
  })
})

describe("debitOrder", () => {
  it("calls bill_order_debit with p_order_id and passes through ok/insufficient/not_found", async () => {
    for (const v of ["ok", "insufficient", "not_found"] as const) {
      const { db, calls } = fakeDb({ data: v })
      expect(await deps(db).debitOrder("o1")).toBe(v)
      expect(calls.find(c => c.fn === "rpc")!.args).toEqual(["bill_order_debit", { p_order_id: "o1" }])
    }
  })
  it("throws on RPC error and on an unexpected result", async () => {
    await expect(deps(fakeDb({ error: { message: "x" } }).db).debitOrder("o1")).rejects.toBeTruthy()
    await expect(deps(fakeDb({ data: "weird" }).db).debitOrder("o1")).rejects.toThrow()
  })
})

describe("findApiOrderByTokenHash", () => {
  it("scopes to user, token hash and channel 'api'", async () => {
    const { db, calls } = fakeDb({ data: { id: "o1", reference_code: "BILL-1" } })
    expect(await deps(db).findApiOrderByTokenHash!("u1", "h1")).toMatchObject({ reference_code: "BILL-1" })
    const eqs = calls.filter(c => c.fn === "eq").map(c => c.args)
    expect(eqs).toEqual(expect.arrayContaining([["user_id", "u1"], ["verify_token_hash", "h1"], ["channel", "api"]]))
    expect(calls[0].args).toEqual(["hubtel_bill_orders"])
  })
  it("null when none; throws on a read error", async () => {
    expect(await deps(fakeDb({ data: null }).db).findApiOrderByTokenHash!("u1", "h1")).toBeNull()
    await expect(deps(fakeDb({ error: { message: "x" } }).db).findApiOrderByTokenHash!("u1", "h1")).rejects.toBeTruthy()
  })
})

describe("updateOrder / getOrder / insertOrder", () => {
  it("guards with .in(status) when given, sets updated_at, returns row count", async () => {
    const { db, calls } = fakeDb({ data: [{ id: "o1" }] })
    expect(await deps(db).updateOrder("o1", { status: "failed" }, ["pending"])).toBe(1)
    expect(calls.find(c => c.fn === "in")!.args).toEqual(["status", ["pending"]])
    const upd = calls.find(c => c.fn === "update")!.args[0]
    expect(upd.status).toBe("failed")
    expect(typeof upd.updated_at).toBe("string")
  })
  it("has no status guard when onlyFromStatuses is omitted; 0 rows -> 0", async () => {
    const { db, calls } = fakeDb({ data: [] })
    expect(await deps(db).updateOrder("o1", { notes: "n" })).toBe(0)
    expect(calls.some(c => c.fn === "in")).toBe(false)
  })
  it("throws on update / get / insert errors; getOrder null when none; insert error object propagates (23505)", async () => {
    await expect(deps(fakeDb({ error: { message: "x" } }).db).updateOrder("o1", {}, ["pending"])).rejects.toBeTruthy()
    await expect(deps(fakeDb({ error: { message: "x" } }).db).getOrder("o1")).rejects.toBeTruthy()
    expect(await deps(fakeDb({ data: null }).db).getOrder("o1")).toBeNull()
    const err = { code: "23505", message: "dup" }
    await expect(deps(fakeDb({ error: err }).db).insertOrder({ verify_token_hash: "h" } as any)).rejects.toBe(err)
  })
  it("newReference is BILL- + 12 hex uppercase, secret/now wired", () => {
    const d = deps(fakeDb({}).db)
    expect(d.newReference()).toMatch(/^BILL-[0-9A-F]{12}$/)
    expect(d.secret).toBe("sek")
    expect(typeof d.now()).toBe("number")
  })
})

describe("listUserBillOrders", () => {
  it("always filters by the caller, orders newest first, limit 50, ignores bad filters", async () => {
    const { db, calls } = fakeDb({ data: [{ id: "o1" }] })
    const rows = await listUserBillOrders(db, "u1", { biller: "nope", status: "bogus", from: "garbage" })
    expect(rows).toEqual([{ id: "o1" }])
    expect(calls.find(c => c.fn === "eq")!.args).toEqual(["user_id", "u1"])
    expect(calls.filter(c => c.fn === "eq")).toHaveLength(1)
    expect(calls.find(c => c.fn === "order")!.args).toEqual(["created_at", { ascending: false }])
    expect(calls.find(c => c.fn === "limit")!.args).toEqual([50])
    expect(calls.find(c => c.fn === "select")!.args[0]).not.toContain("verify_token_hash")
  })
  it("applies valid biller/status/date filters and throws on error", async () => {
    const { db, calls } = fakeDb({ data: [] })
    await listUserBillOrders(db, "u1", { biller: "ecg", status: "failed", from: "2026-01-01", to: "2026-02-01" })
    expect(calls.filter(c => c.fn === "eq").map(c => c.args)).toEqual([["user_id", "u1"], ["biller", "ecg"], ["status", "failed"]])
    expect(calls.some(c => c.fn === "gte")).toBe(true)
    expect(calls.some(c => c.fn === "lte")).toBe(true)
    await expect(listUserBillOrders(fakeDb({ error: { message: "x" } }).db, "u1")).rejects.toBeTruthy()
  })
})
