import { describe, expect, it } from "vitest"
import { buildSpecialContinueDeps, continueSpecialGroups, type SpecialContinueDeps, type UnsentChild } from "./special-continue"
import { DISPATCH_BUDGET_MS } from "./special-service"
import { SPECIAL_WATCH_AGE_MS } from "./special-watch"

const NOW = Date.parse("2026-11-20T20:00:00Z")

function make(rows: UnsentChild[], over: Partial<SpecialContinueDeps> = {}) {
  const sent: { groupId: string; ids: string[]; n: number; startedAt: number }[] = []
  let clock = NOW
  const d: SpecialContinueDeps = {
    listUnsent: async () => rows,
    ledgerOrderIds: async () => new Set<string>(),
    groupSizes: async (gs) => new Map(gs.map(g => [g, 5])),
    dispatchGroup: async (groupId, ids, n, startedAt) => { sent.push({ groupId, ids, n, startedAt }) },
    now: () => clock,
    ...over,
  }
  return { d, sent, tick: (ms: number) => { clock += ms } }
}

const child = (g: string, i: number): UnsentChild => ({ id: `${g}-${i}`, special_group_id: g, special_index: i })

describe("continueSpecialGroups", () => {
  it("sends each group's never-attempted units in special_index order, with the group's full size", async () => {
    const m = make([child("g1", 5), child("g1", 3), child("g1", 4), child("g2", 2)])
    const r = await continueSpecialGroups(m.d, NOW)
    expect(m.sent).toEqual([
      { groupId: "g1", ids: ["g1-3", "g1-4", "g1-5"], n: 5, startedAt: NOW },
      { groupId: "g2", ids: ["g2-2"], n: 5, startedAt: NOW },
    ])
    expect(r).toEqual({ groups: 2, units: 4, skippedLedger: 0 })
  })
  it("never sends a unit that has ANY Hubtel ledger row (it may have reached Hubtel)", async () => {
    const m = make([child("g1", 2), child("g1", 3)], { ledgerOrderIds: async () => new Set(["g1-2"]) })
    const r = await continueSpecialGroups(m.d, NOW)
    expect(m.sent).toEqual([{ groupId: "g1", ids: ["g1-3"], n: 5, startedAt: NOW }])
    expect(r.skippedLedger).toBe(1)
  })
  it("a ledger read error sends nothing (fail closed) and throws", async () => {
    const m = make([child("g1", 2)], { ledgerOrderIds: async () => { throw new Error("db down") } })
    await expect(continueSpecialGroups(m.d, NOW)).rejects.toThrow("db down")
    expect(m.sent).toEqual([])
  })
  it("a group-size read error falls back to the highest unsent index (never sends fewer units)", async () => {
    const m = make([child("g1", 2), child("g1", 3)], { groupSizes: async () => { throw new Error("x") } })
    await continueSpecialGroups(m.d, NOW)
    expect(m.sent).toEqual([{ groupId: "g1", ids: ["g1-2", "g1-3"], n: 3, startedAt: NOW }])
  })
  it("stops starting new groups once the time budget is spent", async () => {
    const m = make([child("g1", 2), child("g2", 2)])
    m.d.dispatchGroup = async (groupId, ids, n, startedAt) => { m.sent.push({ groupId, ids, n, startedAt }); m.tick(DISPATCH_BUDGET_MS + 1) }
    const r = await continueSpecialGroups(m.d, NOW)
    expect(m.sent.map(s => s.groupId)).toEqual(["g1"])
    expect(r.groups).toBe(1)
  })
  it("one group's dispatch throwing does not stop the next group", async () => {
    const m = make([child("g1", 2), child("g2", 2)])
    const seen: string[] = []
    m.d.dispatchGroup = async (groupId) => { seen.push(groupId); if (groupId === "g1") throw new Error("boom") }
    await continueSpecialGroups(m.d, NOW)
    expect(seen).toEqual(["g1", "g2"])
  })
  it("never takes more than 200 rows, so every unit sent was checked against the ledger", async () => {
    const many = Array.from({ length: 250 }, (_, i) => child("g" + i, 1))
    const asked: number[] = []
    const m = make(many, { ledgerOrderIds: async (ids) => { asked.push(ids.length); return new Set() } })
    const r = await continueSpecialGroups(m.d, NOW)
    expect(asked).toEqual([200])
    expect(r.units).toBe(200)
  })
  it("nothing unsent => no ledger read, nothing sent", async () => {
    let ledgerReads = 0
    const m = make([], { ledgerOrderIds: async () => { ledgerReads++; return new Set() } })
    expect(await continueSpecialGroups(m.d, NOW)).toEqual({ groups: 0, units: 0, skippedLedger: 0 })
    expect(ledgerReads).toBe(0)
  })
})

describe("buildSpecialContinueDeps.listUnsent", () => {
  it("selects only paid, pending, never-referenced, never-attempted (notes null) Special children older than the watch age", async () => {
    const calls: { fn: string; args: any[] }[] = []
    const chain: any = new Proxy({}, {
      get(_t, fn: string) {
        if (fn === "then") return (res: any) => res({ data: [child("g1", 2)], error: null })
        return (...args: any[]) => { calls.push({ fn, args }); return chain }
      },
    })
    const db: any = { from: (t: string) => { calls.push({ fn: "from", args: [t] }); return chain } }
    const d = buildSpecialContinueDeps(db, { now: () => NOW } as any)
    expect(await d.listUnsent()).toEqual([child("g1", 2)])
    const by = (fn: string) => calls.filter(c => c.fn === fn).map(c => c.args)
    expect(by("from")).toEqual([["hubtel_data_orders"]])
    expect(by("not")).toEqual([["special_group_id", "is", null]])
    expect(by("eq")).toEqual([["payment_status", "paid"], ["status", "pending"]])
    expect(by("is")).toEqual([["hubtel_client_reference", null], ["notes", null]])
    expect(by("lt")).toEqual([["updated_at", new Date(NOW - SPECIAL_WATCH_AGE_MS).toISOString()]])
    // <= 200: fetchLedgerOrderIds checks only the first 200 ids.
    expect(by("limit")).toEqual([[200]])
    expect(calls.some(c => ["update", "insert", "upsert", "delete"].includes(c.fn))).toBe(false)
  })
  it("a read error throws", async () => {
    const chain: any = new Proxy({}, {
      get(_t, fn: string) {
        if (fn === "then") return (res: any) => res({ data: null, error: { message: "x" } })
        return () => chain
      },
    })
    const d = buildSpecialContinueDeps({ from: () => chain } as any, { now: () => NOW } as any)
    await expect(d.listUnsent()).rejects.toBeTruthy()
  })
})
