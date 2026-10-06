// lib/ussd-hubtel/status-check.test.ts
import { describe, it, expect, vi } from "vitest"
import { statusCheckDisposition, runStatusChecks, STATUS_CHECK_MAX_ATTEMPTS } from "./status-check"
import type { HubtelTxRow, HubtelTxStore, HubtelTxState } from "./types"

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)
const mins = (n: number) => new Date(NOW - n * 60_000).toISOString()
const unpaid = async () => ({ ok: true, status: "Unpaid" })

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
    claim: async (id, from: HubtelTxState[] = ["awaiting_payment"], where) => {
      const r = state.get(id)
      const whereOk = (!where?.callback_status || r?.callback_status === where.callback_status) && (!where?.paid_atIsNull || r?.paid_at == null)
      if (r && from.includes(r.state) && whereOk) { state.set(id, { ...r, state: "processing" }); return true }
      return false
    },
    update: async (id, p) => { const r = state.get(id); if (r) state.set(id, { ...r, ...p }) },
    updateIf: async (id, g, p) => {
      const r = state.get(id)
      const ok = r && r.state === g.state && (!g.callback_status || r.callback_status === g.callback_status) && (!g.paid_atIsNull || r.paid_at == null)
      if (ok) { state.set(id, { ...r, ...p }); return true }
      return false
    },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => [...state.values()].filter(r => r.state === "awaiting_payment"),
    listStaleProcessing: async (olderThanMinutes, limit) => {
      const cutoff = NOW - olderThanMinutes * 60_000
      return [...state.values()].filter(r => r.state === "processing" && new Date(r.updated_at).getTime() < cutoff).slice(0, limit)
    },
    listIndeterminate: async limit =>
      [...state.values()]
        // Same caps as the Supabase query: attempts < 12 and created within the last 24h.
        .filter(r => r.state === "needs_review" && r.callback_status === "not_due" && r.paid_at == null &&
          r.status_check_attempts < 12 && new Date(r.created_at).getTime() > NOW - 24 * 60 * 60_000)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit),
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
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: unpaid, now: NOW })
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
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: unpaid, now: NOW })
    expect(res.expired).toBe(0)
    expect(fail).not.toHaveBeenCalled()
    expect(m.state.get("E")!.state).toBe("processing")
  })

  it("expiry invokes the fail handler only after the row is already failed", async () => {
    const m = store([{ session_id: "F", created_at: mins(90) }])
    let seen: string | undefined
    const fail = vi.fn(async () => { seen = m.state.get("F")!.state })
    await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: unpaid, now: NOW })
    expect(fail).toHaveBeenCalled()
    expect(seen).toBe("failed")
  })

  it("a throwing fail handler does not throw out and the row stays failed", async () => {
    const m = store([{ session_id: "G", created_at: mins(90) }])
    const fail = vi.fn().mockRejectedValue(new Error("boom"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: unpaid, now: NOW })
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
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: unpaid, now: NOW })
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

  // Behaviour change (I1): only a DEFINITE non-Paid answer expires. An errored final check used
  // to expire here too; it now lands in needs_review (see the indeterminate tests below).
  it("(d) a row past 60 minutes whose final check is a definite non-Paid answer is expired", async () => {
    for (const check of [
      async () => ({ ok: true, status: "Unpaid" }),
      async () => ({ ok: true, status: "Refunded" }),
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

  it("(I3) the sweep sets paid_at when missing and records why, keeping an existing paid_at", async () => {
    const m = store([
      { session_id: "N1", state: "processing", created_at: mins(30), updated_at: mins(20), paid_at: null },
      { session_id: "N2", state: "processing", created_at: mins(30), updated_at: mins(20), paid_at: mins(25) },
    ])
    await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: vi.fn(), now: NOW })
    expect(m.state.get("N1")!.paid_at).toBeTruthy()
    expect(m.state.get("N1")!.callback_last_error).toMatch(/recovered from stale processing/)
    expect(m.state.get("N2")!.paid_at).toBe(mins(25))
    expect(m.state.get("N2")!.callback_last_error).toMatch(/recovered from stale processing/)
  })

  it("(M7) the sweep re-reads and skips a row that is no longer processing", async () => {
    const m = store([{ session_id: "Q1", state: "processing", created_at: mins(30), updated_at: mins(20) }])
    // The webhook finishes the row between the list and the sweep update.
    const realList = m.s.listStaleProcessing
    m.s.listStaleProcessing = async (a, b) => {
      const rows = await realList(a, b)
      m.state.set("Q1", { ...m.state.get("Q1")!, state: "fulfilled", callback_status: "sent" })
      return rows
    }
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: vi.fn(), now: NOW })
    expect(res.swept).toBe(0)
    expect(m.state.get("Q1")).toMatchObject({ state: "fulfilled", callback_status: "sent" })
  })
})

describe("runStatusChecks: indeterminate final check at expiry (I1)", () => {
  it("ok:false -> needs_review, callback not_due, fail handler NOT called, logged with session id", async () => {
    const m = store([{ session_id: "I1", created_at: mins(90) }])
    const fail = vi.fn().mockResolvedValue(undefined)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await runStatusChecks({
      store: m.s, handlers: {}, failHandlers: { ussd_orders: fail },
      check: async () => ({ ok: false, error: "relay 401" }), now: NOW,
    })
    expect(res.expired).toBe(0)
    expect(fail).not.toHaveBeenCalled()
    expect(m.state.get("I1")).toMatchObject({ state: "needs_review", callback_status: "not_due" })
    expect(m.state.get("I1")!.callback_last_error).toBe("status check indeterminate at expiry: relay 401")
    expect(JSON.stringify(err.mock.calls)).toContain("I1")
    err.mockRestore()
  })

  it("a thrown final check -> needs_review, fail handler NOT called", async () => {
    const m = store([{ session_id: "I2", created_at: mins(90) }])
    const fail = vi.fn().mockResolvedValue(undefined)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await runStatusChecks({
      store: m.s, handlers: {}, failHandlers: { ussd_orders: fail },
      check: async () => { throw new Error("timeout") }, now: NOW,
    })
    err.mockRestore()
    expect(fail).not.toHaveBeenCalled()
    expect(m.state.get("I2")).toMatchObject({ state: "needs_review", callback_status: "not_due" })
    expect(m.state.get("I2")!.callback_last_error).toMatch(/^status check indeterminate at expiry: .*timeout/)
  })

  it("ok with no status string -> needs_review ('no status')", async () => {
    const m = store([{ session_id: "I3", created_at: mins(90) }])
    const fail = vi.fn().mockResolvedValue(undefined)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await runStatusChecks({
      store: m.s, handlers: {}, failHandlers: { ussd_orders: fail },
      check: async () => ({ ok: true, data: {} }), now: NOW,
    })
    err.mockRestore()
    expect(fail).not.toHaveBeenCalled()
    expect(m.state.get("I3")).toMatchObject({
      state: "needs_review", callback_status: "not_due", callback_last_error: "status check indeterminate at expiry: no status",
    })
  })

  it("ok with status 'Unpaid' -> expired as before", async () => {
    const m = store([{ session_id: "I4", created_at: mins(90) }])
    const fail = vi.fn().mockResolvedValue(undefined)
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: unpaid, now: NOW })
    expect(res.expired).toBe(1)
    expect(fail).toHaveBeenCalledWith("ord-I4")
    expect(m.state.get("I4")).toMatchObject({ state: "failed", callback_status: "not_due" })
  })

  it("indeterminate but the claim is lost (webhook won) -> row untouched", async () => {
    const m = store([{ session_id: "I5", created_at: mins(90) }])
    m.s.claim = async () => false
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: async () => ({ ok: false }), now: NOW })
    err.mockRestore()
    expect(m.state.get("I5")!.state).toBe("awaiting_payment")
  })
})

describe("runStatusChecks: deadline (I4)", () => {
  it("an already-passed deadline processes no rows and returns zero counts", async () => {
    const m = store([
      { session_id: "T1", created_at: mins(10) },
      { session_id: "T2", created_at: mins(90) },
      { session_id: "T3", state: "processing", created_at: mins(30), updated_at: mins(20) },
    ])
    const check = vi.fn(unpaid)
    const fail = vi.fn()
    const res = await runStatusChecks({
      store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check, now: NOW, deadlineMs: Date.now() - 1,
    })
    expect(res).toMatchObject({ checked: 0, paid: 0, expired: 0, swept: 0 })
    expect(check).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(m.state.get("T1")!.status_check_attempts).toBe(0)
    expect(m.state.get("T2")!.state).toBe("awaiting_payment")
    expect(m.state.get("T3")!.state).toBe("processing")
  })

  it("a future deadline does not limit work", async () => {
    const m = store([{ session_id: "T4", created_at: mins(10) }])
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: unpaid, now: NOW, deadlineMs: Date.now() + 60_000 })
    expect(res.checked).toBe(1)
  })

  it("stops starting new rows once the deadline passes mid-run", async () => {
    const m = store([
      { session_id: "T5", created_at: mins(10) },
      { session_id: "T6", created_at: mins(10) },
    ])
    const start = Date.now()
    const deadlineMs = start + 60_000
    let clock = start
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock)
    // The first check takes "longer than the budget": wall clock jumps past the deadline.
    const check = vi.fn(async () => { clock = deadlineMs + 1; return { ok: true, status: "Unpaid" } })
    try {
      const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check, now: NOW, deadlineMs })
      expect(res.checked).toBe(1)
      expect(check).toHaveBeenCalledTimes(1)
    } finally { nowSpy.mockRestore() }
  })
})

describe("runStatusChecks: re-check of indeterminate-expiry rows", () => {
  const parked = (over: Partial<HubtelTxRow> = {}): Partial<HubtelTxRow> => ({
    state: "needs_review", callback_status: "not_due", paid_at: null, created_at: mins(90),
    status_check_attempts: 6, last_status_check_at: mins(30),
    callback_last_error: "status check indeterminate at expiry: relay down", ...over,
  })
  const paidCheck = async () => ({ ok: true, status: "Paid", data: { transactionId: "TX9", amount: 11.5, amountAfterCharges: 10 } })

  it("(d) check says Paid -> recovered (counted), amounts recorded, callback pending, order handler NOT called", async () => {
    const m = store([{ session_id: "K1", ...parked() }])
    const handler = vi.fn().mockResolvedValue(undefined)
    const res = await runStatusChecks({ store: m.s, handlers: { ussd_orders: handler }, failHandlers: {}, check: paidCheck, now: NOW })
    expect(res).toMatchObject({ recovered: 1 })
    expect(handler).not.toHaveBeenCalled()
    expect(m.state.get("K1")).toMatchObject({
      state: "needs_review", callback_status: "pending", hubtel_order_id: "TX9", amount_paid: 11.5, amount_after_charges: 10,
    })
    expect(m.state.get("K1")!.paid_at).toBeTruthy()
  })

  it("(e) check says Unpaid or errors -> row untouched except attempts bumped", async () => {
    for (const check of [unpaid, async () => ({ ok: false, error: "relay down" }), async () => { throw new Error("timeout") }]) {
      const m = store([{ session_id: "K2", ...parked() }])
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check, now: NOW })
      err.mockRestore()
      expect(res).toMatchObject({ recovered: 0 })
      expect(m.state.get("K2")).toMatchObject({
        state: "needs_review", callback_status: "not_due", paid_at: null, hubtel_order_id: null,
        status_check_attempts: 7, callback_last_error: "status check indeterminate at expiry: relay down",
      })
      expect(m.state.get("K2")!.last_status_check_at).toBe(new Date(NOW).toISOString())
    }
  })

  it("(f) rows older than 24h, at 12 attempts, or checked within the gap are skipped", async () => {
    const m = store([
      { session_id: "K3", ...parked({ created_at: mins(24 * 60 + 1) }) },
      { session_id: "K4", ...parked({ status_check_attempts: 12 }) },
      { session_id: "K5", ...parked({ last_status_check_at: mins(2) }) },
    ])
    const check = vi.fn(paidCheck)
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check, now: NOW })
    expect(res).toMatchObject({ recovered: 0 })
    expect(check).not.toHaveBeenCalled()
    for (const id of ["K3", "K4", "K5"]) expect(m.state.get(id)).toMatchObject({ callback_status: "not_due", paid_at: null })
  })

  it("(g) a past deadlineMs skips the phase", async () => {
    const m = store([{ session_id: "K6", ...parked() }])
    const check = vi.fn(paidCheck)
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check, now: NOW, deadlineMs: Date.now() - 1 })
    expect(res).toMatchObject({ recovered: 0 })
    expect(check).not.toHaveBeenCalled()
    expect(m.state.get("K6")).toMatchObject({ status_check_attempts: 6, callback_status: "not_due" })
  })

  it("exhausted parked rows (>= limit of them) do not starve a fresh parked row", async () => {
    const m = store([
      { session_id: "X1", ...parked({ created_at: mins(3000), status_check_attempts: 7 }) }, // older than 24h
      { session_id: "X2", ...parked({ created_at: mins(2000), status_check_attempts: 12 }) },
      { session_id: "X3", ...parked({ created_at: mins(1000), status_check_attempts: 12 }) },
      { session_id: "X4", ...parked({ created_at: mins(90) }) }, // fresh, eligible
    ])
    const check = vi.fn(paidCheck)
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check, now: NOW, limit: 2 })
    expect(check).toHaveBeenCalledWith("X4")
    expect(res).toMatchObject({ recovered: 1 })
    expect(m.state.get("X4")!.callback_status).toBe("pending")
  })

  it("a throwing row does not stop the next one", async () => {
    const m = store([{ session_id: "K7", ...parked({ created_at: mins(100) }) }, { session_id: "K8", ...parked() }])
    const realUpdate = m.s.update
    m.s.update = async (id, p) => { if (id === "K7") throw new Error("db down"); return realUpdate(id, p) }
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: paidCheck, now: NOW })
    err.mockRestore()
    expect(res).toMatchObject({ recovered: 1 })
    expect(m.state.get("K8")!.callback_status).toBe("pending")
  })
})
