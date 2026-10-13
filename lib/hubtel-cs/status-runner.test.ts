import { describe, expect, it, vi } from "vitest"
import { runHubtelCsStatusChecks } from "./status-runner"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx, minutesAfter, T0 } from "./testing/fixtures"

const PAID = async () => ({ ok: true, status: "Paid", data: { status: "Paid", isFulfilled: true } })
const UNPAID = async () => ({ ok: true, status: "Unpaid", data: { status: "Unpaid", isFulfilled: false } })

function run(store: any, check: any, minutes: number, extra: any = {}) {
  const onTransition = vi.fn(async () => {})
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
