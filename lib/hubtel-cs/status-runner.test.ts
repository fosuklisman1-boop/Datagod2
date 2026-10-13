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
