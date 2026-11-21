import { describe, it, expect, vi } from "vitest"
import { markAllowedByAdminCheck } from "./admin-allow"
import { makeFakeDb, hasCall, callArgs, type Call, type FakeResult } from "./test-db"

const NOW = new Date("2026-11-21T10:00:00.000Z")
const rowsIn = [
  { id: "id1", phone: "0241234567", allowedBy: "hubnet" },
  { id: "id2", phone: "0551234567", allowedBy: "codecraft" },
]

function setup(handler: (t: string, c: Call[]) => FakeResult) {
  const fake = makeFakeDb(handler)
  const setCache = vi.fn(async () => {})
  const deps = { db: fake.db as never, now: () => NOW, setCache, getCheckoutProviders: async () => ["kuntanii"] }
  return { fake, setCache, deps }
}

describe("markAllowedByAdminCheck", () => {
  it("flips only blocked/expired rows, stamps the allowing provider, and caches exactly the updated phones", async () => {
    const { fake, setCache, deps } = setup(() => ({ data: [{ id: "id1", phone: "0241234567" }] }))
    const n = await markAllowedByAdminCheck(rowsIn.slice(0, 1), deps)
    expect(n).toEqual({ updatedIds: ["id1"], failed: false })
    const calls = fake.log[0].calls
    expect(callArgs(calls, "update")![0]).toMatchObject({ status: "allowed", allowed_by: "hubnet", allowed_at: NOW.toISOString(), updated_at: NOW.toISOString() })
    expect(hasCall(calls, "in", "status", ["blocked", "expired"])).toBe(true)
    expect(setCache).toHaveBeenCalledWith(new Map([["0241234567", true]]), ["kuntanii"])
  })

  it("a guarded update that returns no row writes no cache and counts nothing", async () => {
    const { setCache, deps } = setup(() => ({ data: [] }))
    const r = await markAllowedByAdminCheck(rowsIn, deps)
    expect(r.updatedIds).toEqual([])
    expect(setCache).not.toHaveBeenCalled()
  })

  it("a db error marks nothing, writes no cache and reports failed", async () => {
    const { setCache, deps } = setup(() => ({ error: { code: "x" } }))
    const r = await markAllowedByAdminCheck(rowsIn, deps)
    expect(r).toEqual({ updatedIds: [], failed: true })
    expect(setCache).not.toHaveBeenCalled()
  })

  it("chunks updates at 500 ids", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: `id${i}`, phone: `024${String(1000000 + i)}`, allowedBy: "a" }))
    const { fake, deps } = setup(() => ({ data: [] }))
    await markAllowedByAdminCheck(many, deps)
    expect(fake.log).toHaveLength(3)
  })

  it("no rows means no db call", async () => {
    const { fake, setCache, deps } = setup(() => ({}))
    expect(await markAllowedByAdminCheck([], deps)).toEqual({ updatedIds: [], failed: false })
    expect(fake.log).toHaveLength(0)
    expect(setCache).not.toHaveBeenCalled()
  })
})
