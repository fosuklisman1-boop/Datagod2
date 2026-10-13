import { afterEach, describe, expect, it, vi } from "vitest"
import { adminCheckStatus, adminRefund, adminResolve } from "./admin-actions"
import { clearOrderAdapters, registerOrderAdapter } from "./adapters"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx, minutesAfter, T0 } from "./testing/fixtures"

afterEach(() => clearOrderAdapters())
const REF = "HCS-airtime_mtn-TESTREF1"

function setup(txOver = {}, check: any = async () => ({ ok: true, status: "Paid", data: { isFulfilled: true } })) {
  const store = createMemoryStore()
  store.seed(makeTx({ client_reference: REF, state: "pending", submitted_at: T0.toISOString(), ...txOver }))
  const onTransition = vi.fn(async () => {})
  return { store, onTransition, deps: { store, checkStatus: check, onTransition, now: () => minutesAfter(12) } }
}

describe("adminCheckStatus", () => {
  it("a Paid + fulfilled answer settles the row and fires the hook", async () => {
    const { deps, store, onTransition } = setup()
    const out = await adminCheckStatus(deps, REF)
    expect(out.ok).toBe(true)
    expect((await store.getByRef(REF))!.state).toBe("fulfilled")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("a relay failure is reported and the row is untouched except attempts", async () => {
    const { deps, store } = setup({}, async () => ({ ok: false, error: "relay not configured" }))
    const out = await adminCheckStatus(deps, REF)
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/relay not configured/)
    expect((await store.getByRef(REF))!.state).toBe("pending")
  })
  it("unknown reference", async () => {
    const out = await adminCheckStatus(setup().deps, "NOPE")
    expect(out).toEqual({ ok: false, message: "Unknown reference", tx: null })
  })
})

describe("adminResolve", () => {
  it("resolves a needs_review row and fires the hook", async () => {
    const { deps, store, onTransition } = setup({ state: "needs_review" })
    const out = await adminResolve(deps, REF, "failed", "never delivered", "admin-1")
    expect(out.ok).toBe(true)
    const tx = (await store.getByRef(REF))!
    expect(tx.state).toBe("failed")
    expect(tx.resolved_by).toBe("admin-1")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("requires a note", async () => {
    const { deps } = setup({ state: "needs_review" })
    expect((await adminResolve(deps, REF, "failed", "  ", "admin-1")).ok).toBe(false)
  })
  it("resolving twice the same way is a no-op", async () => {
    const { deps, onTransition } = setup({ state: "needs_review" })
    await adminResolve(deps, REF, "fulfilled", "ok", "admin-1")
    const again = await adminResolve(deps, REF, "fulfilled", "ok", "admin-1")
    expect(again.ok).toBe(false)
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("cannot resolve an in-flight pending row", async () => {
    const { deps, store, onTransition } = setup({ state: "pending" })
    const out = await adminResolve(deps, REF, "failed", "n", "admin-1")
    expect(out.ok).toBe(false)
    expect((await store.getByRef(REF))!.state).toBe("pending")
    expect(onTransition).not.toHaveBeenCalled()
  })
})

describe("adminRefund", () => {
  it("is refused when no adapter is registered for the row's order table", async () => {
    const { deps } = setup({ state: "failed", order_table: "airtime_orders", order_id: "o1" })
    const out = await adminRefund(deps, REF, "admin-1")
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/no refund handler/i)
  })
  it("only failed rows can be refunded", async () => {
    registerOrderAdapter({ table: "airtime_orders", onFulfilled: async () => {}, onFailed: async () => {}, refundToWallet: async () => ({ refunded: true, message: "ok" }) })
    const { deps } = setup({ state: "fulfilled", order_table: "airtime_orders", order_id: "o1" })
    expect((await adminRefund(deps, REF, "admin-1")).ok).toBe(false)
  })
  it("delegates to the adapter and returns its message", async () => {
    const refundToWallet = vi.fn(async () => ({ refunded: true, message: "Refunded GHS 5.00 to wallet" }))
    registerOrderAdapter({ table: "airtime_orders", onFulfilled: async () => {}, onFailed: async () => {}, refundToWallet })
    const { deps } = setup({ state: "failed", order_table: "airtime_orders", order_id: "o1" })
    const out = await adminRefund(deps, REF, "admin-1")
    expect(out).toMatchObject({ ok: true, message: "Refunded GHS 5.00 to wallet" })
    expect(refundToWallet).toHaveBeenCalledTimes(1)
  })
  it("an adapter error is reported, not thrown", async () => {
    registerOrderAdapter({ table: "airtime_orders", onFulfilled: async () => {}, onFailed: async () => {}, refundToWallet: async () => { throw new Error("wallet locked") } })
    const { deps } = setup({ state: "failed", order_table: "airtime_orders", order_id: "o1" })
    const out = await adminRefund(deps, REF, "admin-1")
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/wallet locked/)
  })
})
