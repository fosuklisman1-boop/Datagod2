import { describe, expect, it, vi } from "vitest"
import { runHubtelCsStatusChecks } from "./status-runner"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx, minutesAfter, T0 } from "./testing/fixtures"

const PAID = async () => ({ ok: true, status: "Paid", data: { status: "Paid", isFulfilled: true } })
const UNPAID = async () => ({ ok: true, status: "Unpaid", data: { status: "Unpaid", isFulfilled: false } })

function run(store: any, check: any, minutes: number, extra: any = {}) {
  const onTransition = vi.fn(async (_tx: any) => {})
  return {
    onTransition,
    out: runHubtelCsStatusChecks({ store, check, onTransition, now: () => minutesAfter(minutes), deadlineMs: Date.now() + 60_000, ...extra }),
  }
}

describe("runHubtelCsStatusChecks", () => {
  it("sweeps created rows older than 2 minutes to needs_review", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "created" }))
    const { out } = run(store, PAID, 3)
    expect((await out).swept).toBe(1)
    expect((await store.getByRef("A"))!.state).toBe("needs_review")
  })
  it("settles an old pending row when Hubtel says Paid + fulfilled, and fires the hook", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    const { out, onTransition } = run(store, PAID, 6)
    expect((await out).fulfilled).toBe(1)
    expect((await store.getByRef("A"))!.state).toBe("fulfilled")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("does not check pending rows younger than 5 minutes", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    const check = vi.fn(PAID)
    const { out } = run(store, check, 4)
    expect((await out).checked).toBe(0)
    expect(check).not.toHaveBeenCalled()
  })
  it("fails a row only after two consecutive negatives across runs, once 10 minutes old", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    await run(store, UNPAID, 12).out
    expect((await store.getByRef("A"))!.state).toBe("pending")
    await run(store, UNPAID, 15).out
    expect((await store.getByRef("A"))!.state).toBe("failed")
  })
  it("skips rows checked in the last 90 seconds", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString(), last_status_check_at: minutesAfter(11).toISOString() }))
    const check = vi.fn(PAID)
    await run(store, check, 12).out
    expect(check).not.toHaveBeenCalled()
  })
  it("pending rows still reconcile while the service is paused (the runner never reads the pause)", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    expect((await run(store, PAID, 6).out).fulfilled).toBe(1)
  })
  it("counts check errors and leaves the row pending", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    const out = await run(store, async () => ({ ok: false, error: "relay down" }), 6).out
    expect(out.errors).toBe(1)
    expect((await store.getByRef("A"))!.state).toBe("pending")
    expect((await store.getByRef("A"))!.status_check_attempts).toBe(1)
  })
  it("stops starting new rows once the deadline passes", async () => {
    const store = createMemoryStore()
    for (const id of ["a", "b", "c"]) store.seed(makeTx({ id, client_reference: id.toUpperCase(), state: "pending", submitted_at: T0.toISOString() }))
    const check = vi.fn(PAID)
    const out = await run(store, check, 6, { deadlineMs: Date.now() - 1 }).out
    expect(out.checked).toBe(0)
    expect(check).not.toHaveBeenCalled()
  })
  it("logs each check as a status_check event", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    await run(store, PAID, 6).out
    expect(store.events.some(e => e.direction === "status_check" && e.client_reference === "A")).toBe(true)
  })
})

describe("runHubtelCsStatusChecks isolation", () => {
  const seedTwo = () => {
    const store = createMemoryStore()
    for (const id of ["a", "b"]) store.seed(makeTx({ id, client_reference: id.toUpperCase(), state: "pending", submitted_at: T0.toISOString() }))
    return store
  }
  it("a row whose store write throws does not abort the rest", async () => {
    const store = seedTwo()
    const orig = store.updateGuarded.bind(store)
    const wrapped = { ...store, updateGuarded: async (id: string, ...r: any[]) => { if (id === "a") throw new Error("db"); return (orig as any)(id, ...r) } }
    const out = await run(wrapped, PAID, 6).out
    expect(out.errors).toBe(1)
    expect(out.fulfilled).toBe(1)
    expect((await store.getByRef("B"))!.state).toBe("fulfilled")
  })
  it("a sweep-phase list error does not block the pending reconcile", async () => {
    const store = seedTwo()
    const orig = store.listByStates.bind(store)
    const wrapped = { ...store, listByStates: async (s: any, o: any) => { if (s[0] === "created") throw new Error("list"); return orig(s, o) } }
    const out = await run(wrapped, PAID, 6).out
    expect(out.errors).toBe(1)
    expect(out.fulfilled).toBe(2)
  })
  it("a pending list error yields a clean summary", async () => {
    const store = seedTwo()
    const wrapped = { ...store, listByStates: async () => { throw new Error("list") } }
    const out = await run(wrapped, PAID, 6).out
    expect(out.errors).toBe(2)
    expect(out.checked).toBe(0)
  })
  it("a throwing onTransition hook does not stop the run", async () => {
    const store = seedTwo()
    const out = await run(store, PAID, 6, { onTransition: async () => { throw new Error("hook") } }).out
    expect(out.fulfilled).toBe(2)
  })
  it("a throwing check() counts as an error and the next row still runs", async () => {
    const store = seedTwo()
    let n = 0
    const out = await run(store, async () => { if (n++ === 0) throw new Error("boom"); return PAID() }, 6).out
    expect(out.errors).toBe(1)
    expect(out.fulfilled).toBe(1)
  })
  it("a logEvent failure does not discard the check result", async () => {
    const store = seedTwo()
    const wrapped = { ...store, logEvent: async () => { throw new Error("log") } }
    const out = await run(wrapped, PAID, 6).out
    expect(out.fulfilled).toBe(2)
    expect(out.errors).toBe(0)
  })
  it("a pending row older than 24h becomes needs_review", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    const out = await run(store, UNPAID, 24 * 60 + 1).out
    expect(out.needsReview).toBe(1)
    expect((await store.getByRef("A"))!.state).toBe("needs_review")
  })
})

describe("runHubtelCsStatusChecks before migrations", () => {
  it("treats a missing ledger table as skipped, not as errors, and does not log at error level", async () => {
    const store = createMemoryStore()
    store.listByStates = async () => { throw { code: "PGRST205", message: "Could not find the table" } }
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { out } = run(store, PAID, 6)
    const res = await out
    expect(res.errors).toBe(0)
    expect(res.skipped).toBe("ledger not migrated")
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })
  it("also tolerates Postgres 42P01 (undefined_table)", async () => {
    const store = createMemoryStore()
    store.listByStates = async () => { throw { code: "42P01", message: "relation does not exist" } }
    const res = await run(store, PAID, 6).out
    expect(res.errors).toBe(0)
    expect(res.skipped).toBe("ledger not migrated")
  })
  it("still counts other list errors as errors", async () => {
    const store = createMemoryStore()
    store.listByStates = async () => { throw new Error("boom") }
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await run(store, PAID, 6).out
    expect(res.errors).toBeGreaterThan(0)
    expect(res.skipped).toBeUndefined()
    err.mockRestore()
  })
})

describe("re-notify sweep (phase 2a)", () => {
  it("retries the order hook for settled rows never synced, older than 2 minutes", async () => {
    const store = createMemoryStore()
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    store.seed(makeTx({ id: "u1", client_reference: "HCS-a", state: "fulfilled", order_table: "airtime_orders", order_id: "o1", order_synced_at: null, updated_at: old }))
    store.seed(makeTx({ id: "u2", client_reference: "HCS-b", state: "failed", order_table: "airtime_orders", order_id: "o2", order_synced_at: old, updated_at: old }))
    store.seed(makeTx({ id: "u3", client_reference: "HCS-c", state: "fulfilled", order_table: null, order_id: null, updated_at: old }))
    store.seed(makeTx({ id: "u4", client_reference: "HCS-d", state: "fulfilled", order_table: "airtime_orders", order_id: "o4", order_synced_at: null, updated_at: new Date().toISOString() }))
    const onTransition = vi.fn(async (_tx: any) => {})
    const out = await runHubtelCsStatusChecks({ store, check: async () => ({ ok: true }), onTransition, deadlineMs: Date.now() + 60_000 })
    expect(onTransition.mock.calls.map((c: any[]) => c[0].id)).toEqual(["u1"])
    expect(out.resyncAttempted).toBe(1)
  })
  it("a missing column or table is skipped quietly, not counted as an error", async () => {
    const store = createMemoryStore()
    ;(store as any).listUnsynced = async () => { throw Object.assign(new Error("column missing"), { code: "42703" }) }
    const out = await runHubtelCsStatusChecks({ store, check: async () => ({ ok: true }), onTransition: async () => {}, deadlineMs: Date.now() + 60_000 })
    expect(out.errors).toBe(0)
  })
})

describe("re-notify sweep fairness (phase 2a fix)", () => {
  it("rotates: rows not reached last run are picked before rows already attempted", async () => {
    const store = createMemoryStore()
    const t = (i: number) => new Date(Date.now() - 60 * 60_000 + i * 1000).toISOString()
    for (let i = 0; i < 60; i++) store.seed(makeTx({ id: `r${i}`, client_reference: `HCS-${i}`, state: "failed", order_table: "airtime_orders", order_id: `o${i}`, updated_at: t(i) }))
    const seen: string[][] = []
    const onTransition = vi.fn(async (_tx: any) => {}) // never marks synced: oldest 50 "always fail"
    const go = async () => {
      onTransition.mockClear()
      await runHubtelCsStatusChecks({ store, check: async () => ({ ok: true }), onTransition, deadlineMs: Date.now() + 60_000 })
      seen.push(onTransition.mock.calls.map((c: any[]) => c[0].id))
    }
    await go()
    expect(seen[0]).toHaveLength(50)
    expect(seen[0]).not.toContain("r55")
    // time passes: the 50 attempts become older than the window
    for (const r of store.rows) if (r.order_sync_attempted_at) r.order_sync_attempted_at = new Date(Date.now() - 10 * 60_000).toISOString()
    await go()
    expect(seen[1].slice(0, 10)).toEqual(["r50", "r51", "r52", "r53", "r54", "r55", "r56", "r57", "r58", "r59"])
  })
  it("does not return a row attempted less than 2 minutes ago", async () => {
    const store = createMemoryStore()
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    store.seed(makeTx({ id: "a", client_reference: "HCS-a", state: "failed", order_table: "t", order_id: "1", updated_at: old }))
    await store.markOrderSyncAttempt("a")
    const cutoff = new Date(Date.now() - 2 * 60_000).toISOString()
    expect(await store.listUnsynced({ olderThan: cutoff, limit: 10 })).toEqual([])
  })
  it("orders never-attempted rows first, then oldest attempt", async () => {
    const store = createMemoryStore()
    const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    store.seed(makeTx({ id: "a", client_reference: "HCS-a", state: "failed", order_table: "t", order_id: "1", updated_at: ago(30), order_sync_attempted_at: ago(10) }))
    store.seed(makeTx({ id: "b", client_reference: "HCS-b", state: "failed", order_table: "t", order_id: "2", updated_at: ago(20), order_sync_attempted_at: ago(20) }))
    store.seed(makeTx({ id: "c", client_reference: "HCS-c", state: "failed", order_table: "t", order_id: "3", updated_at: ago(10) }))
    expect((await store.listUnsynced({ olderThan: ago(2), limit: 10 })).map(r => r.id)).toEqual(["c", "b", "a"])
  })
  it("a row that cannot be stamped is skipped without running the hook", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "HCS-a", state: "failed", order_table: "t", order_id: "1", updated_at: new Date(Date.now() - 10 * 60_000).toISOString() }))
    ;(store as any).markOrderSyncAttempt = async () => { throw new Error("db") }
    const onTransition = vi.fn(async (_tx: any) => {})
    await runHubtelCsStatusChecks({ store, check: async () => ({ ok: true }), onTransition, deadlineMs: Date.now() + 60_000 })
    expect(onTransition).not.toHaveBeenCalled()
  })
  it("PGRST205 in the re-notify phase is skipped quietly", async () => {
    const store = createMemoryStore()
    ;(store as any).listUnsynced = async () => { throw Object.assign(new Error("no table"), { code: "PGRST205" }) }
    const out = await runHubtelCsStatusChecks({ store, check: async () => ({ ok: true }), onTransition: async () => {}, deadlineMs: Date.now() + 60_000 })
    expect(out.errors).toBe(0)
  })
})
