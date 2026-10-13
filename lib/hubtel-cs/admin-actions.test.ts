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

describe("adminRefund atomic claim", () => {
  const reg = (refundToWallet: any) => registerOrderAdapter({ table: "airtime_orders", onFulfilled: async () => {}, onFailed: async () => {}, refundToWallet })
  const failedRow = { state: "failed", order_table: "airtime_orders", order_id: "o1" }
  it("concurrent refunds call the adapter exactly once", async () => {
    const refundToWallet = vi.fn(async () => ({ refunded: true, message: "done" })); reg(refundToWallet)
    const { deps } = setup(failedRow)
    const [a, b] = await Promise.all([adminRefund(deps, REF, "admin-1"), adminRefund(deps, REF, "admin-2")])
    expect(refundToWallet).toHaveBeenCalledTimes(1)
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })
  it("sequential second refund is refused as already claimed", async () => {
    const refundToWallet = vi.fn(async () => ({ refunded: true, message: "done" })); reg(refundToWallet)
    const { deps } = setup(failedRow)
    await adminRefund(deps, REF, "admin-1")
    const again = await adminRefund(deps, REF, "admin-1")
    expect(again.ok).toBe(false)
    expect(again.message).toMatch(/already claimed/i)
    expect(refundToWallet).toHaveBeenCalledTimes(1)
  })
  it("refunded:false releases the claim so a retry works", async () => {
    const refundToWallet = vi.fn().mockResolvedValueOnce({ refunded: false, message: "nothing credited" }).mockResolvedValueOnce({ refunded: true, message: "done" })
    reg(refundToWallet)
    const { deps, store } = setup(failedRow)
    const first = await adminRefund(deps, REF, "admin-1")
    expect(first).toMatchObject({ ok: false, message: "nothing credited" })
    expect((await store.getByRef(REF))!.refund_claimed_at).toBeNull()
    expect((await adminRefund(deps, REF, "admin-1")).ok).toBe(true)
    expect(refundToWallet).toHaveBeenCalledTimes(2)
  })
  it("a throwing adapter keeps the claim; second attempt does not call it", async () => {
    const refundToWallet = vi.fn(async () => { throw new Error("wallet locked") }); reg(refundToWallet)
    const { deps, store } = setup(failedRow)
    const first = await adminRefund(deps, REF, "admin-1")
    expect(first.ok).toBe(false)
    expect(first.message).toMatch(/unknown/i)
    expect(first.message).toMatch(/check the wallet/i)
    expect((await store.getByRef(REF))!.refund_claimed_at).not.toBeNull()
    await adminRefund(deps, REF, "admin-1")
    expect(refundToWallet).toHaveBeenCalledTimes(1)
  })
  it("claim never succeeds on a non-failed row", async () => {
    const { deps, store } = setup({ state: "fulfilled" })
    const row = (await store.getByRef(REF))!
    expect(await store.claimRefund(row.id, "a")).toBeNull()
    void deps
  })
  it("admin-overridden rows need force and always expose provenance", async () => {
    const refundToWallet = vi.fn(async () => ({ refunded: true, message: "done" })); reg(refundToWallet)
    const { deps } = setup({ ...failedRow, resolved_by: "admin-9", resolved_at: T0.toISOString(), resolution_note: "never delivered" })
    const blocked = await adminRefund(deps, REF, "admin-1")
    expect(blocked.ok).toBe(false)
    expect(blocked.message).toMatch(/force/i)
    expect(blocked.provenance).toEqual({ resolved_by: "admin-9", resolution_note: "never delivered" })
    expect(refundToWallet).not.toHaveBeenCalled()
    const forced = await adminRefund(deps, REF, "admin-1", { force: true })
    expect(forced.ok).toBe(true)
    expect(forced.provenance).toEqual({ resolved_by: "admin-9", resolution_note: "never delivered" })
  })
  it("returns the fresh row after a successful refund", async () => {
    reg(async () => ({ refunded: true, message: "done" }))
    const { deps } = setup(failedRow)
    const out = await adminRefund(deps, REF, "admin-1")
    expect(out.tx!.refund_claimed_at).not.toBeNull()
  })
})

describe("adminResolve vs refund", () => {
  it("refuses to flip a refunded order to fulfilled", async () => {
    const { deps, onTransition } = setup({ state: "failed", refund_claimed_at: T0.toISOString(), refund_claimed_by: "admin-1" })
    const out = await adminResolve(deps, REF, "fulfilled", "actually delivered", "admin-2")
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/refund/i)
    expect(onTransition).not.toHaveBeenCalled()
  })
})

describe("adminCheckStatus throwing checkStatus", () => {
  it("is reported, not thrown, and leaves the row untouched", async () => {
    const { deps, store } = setup({}, async () => { throw new Error("socket hang up") })
    const out = await adminCheckStatus(deps, REF)
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/socket hang up/)
    const row = (await store.getByRef(REF))!
    expect(row.state).toBe("pending")
    expect(row.status_check_attempts).toBe(0)
  })
})

describe("adminCheckStatus recheck gap", () => {
  const UNPAID = async () => ({ ok: true, status: "Unpaid", data: { isFulfilled: false } })
  it("two admin checks seconds apart cannot fail a row", async () => {
    const { deps, store } = setup({}, UNPAID)
    await adminCheckStatus(deps, REF)
    expect((await store.getByRef(REF))!.negative_checks).toBe(1)
    const second = await adminCheckStatus({ ...deps, now: () => new Date(minutesAfter(12).getTime() + 5_000) }, REF)
    const tx = (await store.getByRef(REF))!
    expect(tx.state).toBe("pending")
    expect(tx.negative_checks).toBe(1)
    expect(tx.status_check_attempts).toBe(2)
    expect(second.message).toMatch(/not counted/i)
  })
  it("a check after the gap counts again", async () => {
    const { deps, store } = setup({}, UNPAID)
    await adminCheckStatus(deps, REF)
    await adminCheckStatus({ ...deps, now: () => minutesAfter(15) }, REF)
    expect((await store.getByRef(REF))!.state).toBe("failed")
  })
})

describe("adminResolve guards", () => {
  it("a refund claim landing between read and write wins over resolving to fulfilled", async () => {
    const { deps, store, onTransition } = setup({ state: "failed" })
    const realGet = store.getByRef.bind(store)
    // simulate: the read sees no claim, then a claim lands before the write
    store.getByRef = async (ref: string) => {
      const r = await realGet(ref)
      const row = store.rows.find(x => x.client_reference === ref)!
      queueMicrotask(() => { row.refund_claimed_at = T0.toISOString() })
      return r
    }
    const out = await adminResolve(deps, REF, "fulfilled", "paid in fact", "admin-1")
    expect(out.ok).toBe(false)
    expect((await realGet(REF))!.state).toBe("failed")
    expect(onTransition).not.toHaveBeenCalled()
  })
  it("a unique violation during resolve is a clear ok:false message", async () => {
    const { deps, store } = setup({ state: "failed", order_table: "airtime_orders", order_id: "o1" })
    store.seed(makeTx({ id: "tx-2", client_reference: "OTHER", state: "pending", order_table: "airtime_orders", order_id: "o1" }))
    const out = await adminResolve(deps, REF, "fulfilled", "paid in fact", "admin-1")
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/another active purchase exists for this order/i)
    expect((await store.getByRef(REF))!.state).toBe("failed")
  })
  it("a real 23505 error code is mapped the same way", async () => {
    const { deps, store } = setup({ state: "failed" })
    store.updateGuarded = async () => { throw { code: "23505", message: "dup" } }
    const out = await adminResolve(deps, REF, "fulfilled", "n", "admin-1")
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/another active purchase exists/i)
  })
})
