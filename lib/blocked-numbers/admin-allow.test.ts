import { describe, it, expect, vi } from "vitest"
import { markAllowedByAdminCheck } from "./admin-allow"
import { makeFakeDb, hasCall, callArgs, type Call, type FakeResult } from "./test-db"

const NOW = new Date("2026-11-21T10:00:00.000Z")
const rowsIn = [
  { id: "id1", phone: "0241234567", allowedBy: "hubnet" },
  { id: "id2", phone: "0551234567", allowedBy: "codecraft" },
]

function setup(handler: (t: string, c: Call[]) => FakeResult, readBack: (phones: string[]) => Map<string, boolean> = (p) => new Map(p.map((x) => [x, true]))) {
  const fake = makeFakeDb(handler)
  const order: string[] = []
  const setCache = vi.fn(async () => { order.push("set") })
  const getCache = vi.fn(async (phones: string[]) => { order.push("get"); return readBack(phones) })
  const deps = { db: fake.db as never, now: () => NOW, setCache, getCache, getCheckoutProviders: async () => ["kuntanii"] }
  return { fake, setCache, getCache, order, deps }
}

describe("markAllowedByAdminCheck", () => {
  it("writes and reads back the verified verdict BEFORE the status update, then flips", async () => {
    const { fake, setCache, getCache, order, deps } = setup(() => {
      order.push("update")
      return { data: [{ id: "id1", phone: "0241234567" }] }
    })
    const r = await markAllowedByAdminCheck(rowsIn.slice(0, 1), deps)
    expect(r).toEqual({ updatedIds: ["id1"], failed: false, cacheFailed: 0 })
    expect(order).toEqual(["set", "get", "update"])
    expect(setCache).toHaveBeenCalledWith(new Map([["0241234567", true]]), ["kuntanii"])
    expect(getCache).toHaveBeenCalledWith(["0241234567"], ["kuntanii"])
    const calls = fake.log[0].calls
    expect(callArgs(calls, "update")![0]).toMatchObject({ status: "allowed", allowed_by: "hubnet", allowed_at: NOW.toISOString(), updated_at: NOW.toISOString() })
    expect(hasCall(calls, "in", "status", ["blocked", "expired"])).toBe(true)
  })

  it("a phone whose cache read-back is not true is not flipped and is counted as cacheFailed", async () => {
    const { fake, deps } = setup(() => ({ data: [{ id: "id2", phone: "0551234567" }] }), () => new Map([["0241234567", false]]))
    const r = await markAllowedByAdminCheck(rowsIn, deps)
    expect(r.updatedIds).toEqual([])
    expect(r).toMatchObject({ failed: true, cacheFailed: 2 })
    expect(fake.log).toHaveLength(0)
  })

  it("only phones that read back true are updated", async () => {
    const { fake, deps } = setup(() => ({ data: [{ id: "id1", phone: "0241234567" }] }), () => new Map([["0241234567", true]]))
    const r = await markAllowedByAdminCheck(rowsIn, deps)
    expect(r).toEqual({ updatedIds: ["id1"], failed: true, cacheFailed: 1 })
    expect(fake.log).toHaveLength(1)
    expect(hasCall(fake.log[0].calls, "in", "id", ["id1"])).toBe(true)
  })

  it("a throwing cache write or read marks nothing", async () => {
    const { fake, deps } = setup(() => ({ data: [] }))
    deps.setCache.mockRejectedValueOnce(new Error("redis"))
    const r = await markAllowedByAdminCheck(rowsIn, deps)
    expect(r).toMatchObject({ updatedIds: [], failed: true, cacheFailed: 2 })
    expect(fake.log).toHaveLength(0)
  })

  it("a guarded update that returns no row counts nothing (harmless verified cache entry may remain)", async () => {
    const { deps } = setup(() => ({ data: [] }))
    const r = await markAllowedByAdminCheck(rowsIn, deps)
    expect(r).toEqual({ updatedIds: [], failed: false, cacheFailed: 0 })
  })

  it("a db error reports failed with nothing counted", async () => {
    const { deps } = setup(() => ({ error: { code: "x" } }))
    const r = await markAllowedByAdminCheck(rowsIn, deps)
    expect(r).toEqual({ updatedIds: [], failed: true, cacheFailed: 0 })
  })

  it("chunks updates at 500 ids", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: `id${i}`, phone: `024${String(1000000 + i)}`, allowedBy: "a" }))
    const { fake, deps } = setup(() => ({ data: [] }))
    await markAllowedByAdminCheck(many, deps)
    expect(fake.log).toHaveLength(3)
  })

  it("no rows means no db or cache call", async () => {
    const { fake, setCache, getCache, deps } = setup(() => ({}))
    expect(await markAllowedByAdminCheck([], deps)).toEqual({ updatedIds: [], failed: false, cacheFailed: 0 })
    expect(fake.log).toHaveLength(0)
    expect(setCache).not.toHaveBeenCalled()
    expect(getCache).not.toHaveBeenCalled()
  })
})
