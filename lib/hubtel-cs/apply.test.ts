import { describe, it, expect, vi } from "vitest"
import { applyAndCommit } from "./apply"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx } from "./testing/fixtures"

describe("applyAndCommit", () => {
  it("fires the hook once when a row enters a terminal state", async () => {
    const store = createMemoryStore()
    const tx = store.seed(makeTx({ state: "pending" }))
    const hook = vi.fn(async () => {})
    const out = await applyAndCommit(store, tx, { next: "fulfilled", patch: { state: "fulfilled" } }, hook)
    expect(out.changed).toBe(true)
    expect(out.tx.state).toBe("fulfilled")
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it("does not fire the hook for a non-terminal update (e.g. status-check bookkeeping)", async () => {
    const store = createMemoryStore()
    const tx = store.seed(makeTx({ state: "pending" }))
    const hook = vi.fn(async () => {})
    const out = await applyAndCommit(store, tx, { next: "pending", patch: { state: "pending", status_check_attempts: 1 } }, hook)
    expect(out.changed).toBe(true)
    expect(hook).not.toHaveBeenCalled()
  })

  it("ignored transitions change nothing", async () => {
    const store = createMemoryStore()
    const tx = store.seed(makeTx({ state: "fulfilled" }))
    const hook = vi.fn(async () => {})
    const out = await applyAndCommit(store, tx, { ignored: "already fulfilled" }, hook)
    expect(out).toEqual({ tx, changed: false })
    expect(hook).not.toHaveBeenCalled()
  })

  it("loses a race gracefully: guard fails, current row returned, hook not fired", async () => {
    const store = createMemoryStore()
    const stale = makeTx({ state: "pending" })
    store.seed({ ...stale, state: "fulfilled" })
    const hook = vi.fn(async () => {})
    const out = await applyAndCommit(store, stale, { next: "failed", patch: { state: "failed" } }, hook)
    expect(out.changed).toBe(false)
    expect(out.tx.state).toBe("fulfilled")
    expect(hook).not.toHaveBeenCalled()
  })
})
