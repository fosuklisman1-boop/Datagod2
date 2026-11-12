import { describe, it, expect } from "vitest"
import { callerOwnsOrder, callerOwnsShopOrder } from "./support-ownership"
import { makeFakeDb, type FakeCall, type FakeResult } from "../app/api/support/_fake-db"

const run = (h: (c: FakeCall) => FakeResult | undefined) => makeFakeDb(h)

describe("callerOwnsOrder", () => {
  it("true when a row matches id and user", async () => {
    const f = run(() => ({ data: { id: "o1" } }))
    expect(await callerOwnsOrder(f.db as any, "u1", "o1")).toBe(true)
    expect(f.calls[0].filters).toEqual([["id", "o1"], ["user_id", "u1"]])
  })
  it("false when no row", async () => {
    expect(await callerOwnsOrder(run(() => ({ data: null })).db as any, "u1", "o1")).toBe(false)
  })
  it("throws on a database error rather than answering", async () => {
    await expect(callerOwnsOrder(run(() => ({ error: { message: "x" } })).db as any, "u1", "o1")).rejects.toThrow()
  })
})

describe("callerOwnsShopOrder", () => {
  it("true when the shop belongs to the caller", async () => {
    const f = run((c) => (c.table === "shop_orders" ? { data: { shop_id: "s1" } } : { data: { id: "s1" } }))
    expect(await callerOwnsShopOrder(f.db as any, "u1", "so1")).toBe(true)
    expect(f.calls[1].filters).toEqual([["id", "s1"], ["user_id", "u1"]])
  })
  it("false when the shop belongs to someone else", async () => {
    const f = run((c) => (c.table === "shop_orders" ? { data: { shop_id: "s1" } } : { data: null }))
    expect(await callerOwnsShopOrder(f.db as any, "u1", "so1")).toBe(false)
  })
  it("false when the shop order is missing or has no shop, without querying shops", async () => {
    const f = run(() => ({ data: null }))
    expect(await callerOwnsShopOrder(f.db as any, "u1", "so1")).toBe(false)
    expect(f.calls.map((c) => c.table)).toEqual(["shop_orders"])
  })
  it("throws on a database error", async () => {
    await expect(callerOwnsShopOrder(run(() => ({ error: { message: "x" } })).db as any, "u1", "so1")).rejects.toThrow()
  })
})
