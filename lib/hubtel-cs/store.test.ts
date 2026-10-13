import { describe, it, expect } from "vitest"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx, T0 } from "./testing/fixtures"

describe("memory store contract", () => {
  it("insert creates a created row and rejects a duplicate client_reference", async () => {
    const s = createMemoryStore()
    const tx = await s.insert({ client_reference: "HCS-a-1", service_key: "airtime_mtn", kind: "airtime", destination: "233246912184", amount: 5 })
    expect(tx.state).toBe("created")
    await expect(s.insert({ client_reference: "HCS-a-1", service_key: "airtime_mtn", kind: "airtime", destination: "x", amount: 1 })).rejects.toThrow(/duplicate/i)
  })

  it("updateGuarded only applies when the expected state still matches", async () => {
    const s = createMemoryStore()
    const tx = s.seed(makeTx({ state: "pending" }))
    expect(await s.updateGuarded(tx.id, "created", { state: "fulfilled" })).toBeNull()
    expect((await s.getByRef(tx.client_reference))!.state).toBe("pending")
    const ok = await s.updateGuarded(tx.id, "pending", { state: "fulfilled" })
    expect(ok!.state).toBe("fulfilled")
  })

  it("listByStates filters by state and age and orders never-checked rows first", async () => {
    const s = createMemoryStore()
    s.seed(makeTx({ id: "a", client_reference: "A", state: "pending", created_at: "2026-10-13T09:00:00.000Z", last_status_check_at: "2026-10-13T09:50:00.000Z" }))
    s.seed(makeTx({ id: "b", client_reference: "B", state: "pending", created_at: "2026-10-13T09:10:00.000Z", last_status_check_at: null }))
    s.seed(makeTx({ id: "c", client_reference: "C", state: "pending", created_at: "2026-10-13T09:59:00.000Z" }))
    s.seed(makeTx({ id: "d", client_reference: "D", state: "fulfilled", created_at: "2026-10-13T09:00:00.000Z" }))
    const rows = await s.listByStates(["pending"], { olderThan: "2026-10-13T09:55:00.000Z", limit: 10, orderBy: "last_status_check_at" })
    expect(rows.map(r => r.id)).toEqual(["b", "a"])
  })

  it("listForAdmin supports the attention filter and free-text search", async () => {
    const s = createMemoryStore()
    s.seed(makeTx({ id: "a", client_reference: "REF-AAA", state: "needs_review", destination: "233246912184" }))
    s.seed(makeTx({ id: "b", client_reference: "REF-BBB", state: "failed", destination: "233200000001" }))
    s.seed(makeTx({ id: "c", client_reference: "REF-CCC", state: "fulfilled", destination: "233200000002" }))
    expect((await s.listForAdmin({ state: "attention", limit: 10, offset: 0 })).total).toBe(2)
    expect((await s.listForAdmin({ q: "6912184", limit: 10, offset: 0 })).rows.map(r => r.id)).toEqual(["a"])
  })

  it("stats aggregates states and fulfilled commission", async () => {
    const s = createMemoryStore()
    s.seed(makeTx({ id: "a", client_reference: "A", state: "fulfilled", commission: 0.5 }))
    s.seed(makeTx({ id: "b", client_reference: "B", state: "fulfilled", commission: 0.25 }))
    s.seed(makeTx({ id: "c", client_reference: "C", state: "pending", commission: 9 }))
    s.seed(makeTx({ id: "d", client_reference: "D", state: "needs_review" }))
    expect(await s.stats()).toEqual({ total: 4, in_flight: 1, needs_review: 1, failed: 0, fulfilled: 2, commission_earned: 0.75 })
  })

  it("logEvent never throws", async () => {
    const s = createMemoryStore()
    await expect(s.logEvent({ client_reference: "A", direction: "request" })).resolves.toBeUndefined()
    expect(s.events).toHaveLength(1)
    void T0
  })
})
