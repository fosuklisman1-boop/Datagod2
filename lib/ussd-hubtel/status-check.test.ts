// lib/ussd-hubtel/status-check.test.ts
import { describe, it, expect, vi } from "vitest"
import { statusCheckDisposition, runStatusChecks, STATUS_CHECK_MAX_ATTEMPTS } from "./status-check"
import type { HubtelTxRow, HubtelTxStore, HubtelTxState } from "./types"

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)
const mins = (n: number) => new Date(NOW - n * 60_000).toISOString()

describe("statusCheckDisposition", () => {
  const base = { status_check_attempts: 0, last_status_check_at: null as string | null }
  it("skips orders younger than 5 minutes", () => expect(statusCheckDisposition({ ...base, created_at: mins(2) }, NOW)).toBe("skip"))
  it("checks orders between 5 and 60 minutes old", () => expect(statusCheckDisposition({ ...base, created_at: mins(8) }, NOW)).toBe("check"))
  it("skips when checked less than 5 minutes ago", () =>
    expect(statusCheckDisposition({ ...base, created_at: mins(20), last_status_check_at: mins(2) }, NOW)).toBe("skip"))
  it("expires after 60 minutes or after the attempt cap", () => {
    expect(statusCheckDisposition({ ...base, created_at: mins(61) }, NOW)).toBe("expire")
    expect(statusCheckDisposition({ ...base, created_at: mins(20), status_check_attempts: STATUS_CHECK_MAX_ATTEMPTS }, NOW)).toBe("expire")
  })
})

function store(rows: Partial<HubtelTxRow>[]) {
  const state = new Map<string, HubtelTxRow>(
    rows.map(r => [r.session_id!, {
      hubtel_order_id: null, platform: "USSD", order_table: "ussd_orders", order_id: "ord-" + r.session_id, mobile: null,
      expected_amount: 10, amount_paid: null, amount_after_charges: null, state: "awaiting_payment",
      callback_status: "not_due", callback_attempts: 0, callback_last_error: null, callback_sent_at: null,
      status_check_attempts: 0, last_status_check_at: null, paid_at: null, updated_at: new Date(NOW).toISOString(), ...r,
    } as HubtelTxRow])
  )
  const s: HubtelTxStore = {
    findBySession: async id => state.get(id) ?? null,
    claim: async (id, from: HubtelTxState[] = ["awaiting_payment"]) => {
      const r = state.get(id)
      if (r && from.includes(r.state)) { state.set(id, { ...r, state: "processing" }); return true }
      return false
    },
    update: async (id, p) => { const r = state.get(id); if (r) state.set(id, { ...r, ...p }) },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => [...state.values()].filter(r => r.state === "awaiting_payment"),
    listStaleProcessing: async (olderThanMinutes, limit) => {
      const cutoff = NOW - olderThanMinutes * 60_000
      return [...state.values()].filter(r => r.state === "processing" && new Date(r.updated_at).getTime() < cutoff).slice(0, limit)
    },
  }
  return { s, state }
}

describe("runStatusChecks", () => {
  it("fulfils a Paid transaction found by the status check", async () => {
    const m = store([{ session_id: "A", created_at: mins(10) }])
    const handler = vi.fn().mockResolvedValue(undefined)
    const res = await runStatusChecks({
      store: m.s, handlers: { ussd_orders: handler }, failHandlers: {},
      check: async () => ({ ok: true, status: "Paid", data: { status: "Paid", transactionId: "T9", amount: 11.5, amountAfterCharges: 10 } }),
      now: NOW,
    })
    expect(res).toMatchObject({ checked: 1, paid: 1, expired: 0, swept: 0 })
    expect(handler).toHaveBeenCalledWith("ord-A")
    expect(m.state.get("A")).toMatchObject({ state: "fulfilled", hubtel_order_id: "T9", callback_status: "pending" })
  })

  it("leaves Unpaid rows waiting and records the attempt", async () => {
    const m = store([{ session_id: "B", created_at: mins(10) }])
    await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: async () => ({ ok: true, status: "Unpaid", data: { status: "Unpaid" } }), now: NOW })
    expect(m.state.get("B")).toMatchObject({ state: "awaiting_payment", status_check_attempts: 1 })
    expect(m.state.get("B")!.last_status_check_at).toBeTruthy()
  })

  it("a failed check call still counts as an attempt and never throws", async () => {
    const m = store([{ session_id: "C", created_at: mins(10) }])
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: async () => ({ ok: false, error: "relay down" }), now: NOW })
    expect(res.checked).toBe(1)
    expect(m.state.get("C")!.status_check_attempts).toBe(1)
  })

  it("expires stale unpaid orders: row failed, order failed, no callback", async () => {
    const m = store([{ session_id: "D", created_at: mins(90) }])
    const fail = vi.fn().mockResolvedValue(undefined)
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: vi.fn(), now: NOW })
    expect(res.expired).toBe(1)
    expect(fail).toHaveBeenCalledWith("ord-D")
    expect(m.state.get("D")).toMatchObject({ state: "failed", callback_status: "not_due" })
  })

  it("expiry skips when the claim is lost (webhook won the race)", async () => {
    const m = store([{ session_id: "E", created_at: mins(90) }])
    const fail = vi.fn().mockResolvedValue(undefined)
    // A webhook claims the row between the list and the expiry claim.
    const realClaim = m.s.claim
    m.s.claim = async (id, from) => {
      m.state.set(id, { ...m.state.get(id)!, state: "processing" })
      return realClaim(id, from)
    }
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: vi.fn(), now: NOW })
    expect(res.expired).toBe(0)
    expect(fail).not.toHaveBeenCalled()
    expect(m.state.get("E")!.state).toBe("processing")
  })

  it("expiry invokes the fail handler only after the row is already failed", async () => {
    const m = store([{ session_id: "F", created_at: mins(90) }])
    let seen: string | undefined
    const fail = vi.fn(async () => { seen = m.state.get("F")!.state })
    await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: vi.fn(), now: NOW })
    expect(fail).toHaveBeenCalled()
    expect(seen).toBe("failed")
  })

  it("a throwing fail handler does not throw out and the row stays failed", async () => {
    const m = store([{ session_id: "G", created_at: mins(90) }])
    const fail = vi.fn().mockRejectedValue(new Error("boom"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: vi.fn(), now: NOW })
    spy.mockRestore()
    expect(res.expired).toBe(1)
    expect(m.state.get("G")).toMatchObject({ state: "failed", callback_status: "not_due" })
  })

  it("(a) a throwing update on one row does not stop the next row or throw out", async () => {
    const m = store([
      { session_id: "XA", created_at: mins(10) },
      { session_id: "XB", created_at: mins(10) },
    ])
    const realUpdate = m.s.update
    m.s.update = async (id, p) => { if (id === "XA") throw new Error("db down"); return realUpdate(id, p) }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: async () => ({ ok: true, status: "Unpaid" }), now: NOW })
    spy.mockRestore()
    expect(res.checked).toBe(2)
    expect(m.state.get("XB")!.status_check_attempts).toBe(1)
  })

  it("(a2) a throwing sweep update does not stop the rest", async () => {
    const m = store([
      { session_id: "W1", state: "processing", created_at: mins(30), updated_at: mins(20) },
      { session_id: "W2", state: "processing", created_at: mins(30), updated_at: mins(20) },
    ])
    const realUpdate = m.s.update
    m.s.update = async (id, p) => { if (id === "W1") throw new Error("db down"); return realUpdate(id, p) }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: vi.fn(), now: NOW })
    spy.mockRestore()
    expect(res.swept).toBe(1)
    expect(m.state.get("W2")!.state).toBe("needs_review")
  })

  it("(b) expiry whose post-claim update throws reverts the row and skips the fail handler", async () => {
    const m = store([{ session_id: "H", created_at: mins(90) }])
    const fail = vi.fn().mockResolvedValue(undefined)
    const realUpdate = m.s.update
    m.s.update = async (id, p) => {
      if (p.state === "failed") throw new Error("db down")
      return realUpdate(id, p)
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: async () => ({ ok: false }), now: NOW })
    spy.mockRestore()
    expect(res.expired).toBe(0)
    expect(fail).not.toHaveBeenCalled()
    expect(m.state.get("H")!.state).toBe("awaiting_payment")
  })

  it("(c) a row past 60 minutes whose final check says Paid is fulfilled, not expired", async () => {
    const m = store([{ session_id: "P", created_at: mins(90) }])
    const handler = vi.fn().mockResolvedValue(undefined)
    const fail = vi.fn().mockResolvedValue(undefined)
    const res = await runStatusChecks({
      store: m.s, handlers: { ussd_orders: handler }, failHandlers: { ussd_orders: fail },
      check: async () => ({ ok: true, status: "Paid", data: { transactionId: "T1", amount: 11.5, amountAfterCharges: 10 } }),
      now: NOW,
    })
    expect(res).toMatchObject({ paid: 1, expired: 0 })
    expect(handler).toHaveBeenCalledWith("ord-P")
    expect(fail).not.toHaveBeenCalled()
    expect(m.state.get("P")).toMatchObject({ state: "fulfilled", callback_status: "pending" })
  })

  it("(d) a row past 60 minutes whose final check is Unpaid or errors is still expired", async () => {
    for (const check of [
      async () => ({ ok: true, status: "Unpaid" }),
      async () => ({ ok: false, error: "relay down" }),
    ]) {
      const m = store([{ session_id: "U", created_at: mins(90) }])
      const fail = vi.fn().mockResolvedValue(undefined)
      const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check, now: NOW })
      expect(res.expired).toBe(1)
      expect(m.state.get("U")).toMatchObject({ state: "failed", callback_status: "not_due" })
    }
  })

  it("(e) Paid check on a row the webhook already claimed -> paid 0, handler not called, warns", async () => {
    const m = store([{ session_id: "R", created_at: mins(10) }])
    m.s.claim = async () => false
    const handler = vi.fn().mockResolvedValue(undefined)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await runStatusChecks({
      store: m.s, handlers: { ussd_orders: handler }, failHandlers: {},
      check: async () => ({ ok: true, status: "Paid", data: { transactionId: "T2", amount: 11.5, amountAfterCharges: 10 } }),
      now: NOW,
    })
    expect(res.paid).toBe(0)
    expect(handler).not.toHaveBeenCalled()
    expect(m.state.get("R")!.status_check_attempts).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("sweeps stale processing rows to needs_review with a pending callback; leaves fresh ones", async () => {
    const m = store([
      { session_id: "S1", state: "processing", created_at: mins(30), updated_at: mins(20) },
      { session_id: "S2", state: "processing", created_at: mins(30), updated_at: mins(2) },
    ])
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: vi.fn(), now: NOW })
    expect(res.swept).toBe(1)
    expect(m.state.get("S1")).toMatchObject({ state: "needs_review", callback_status: "pending" })
    expect(m.state.get("S2")!.state).toBe("processing")
  })
})
