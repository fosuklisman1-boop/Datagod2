// lib/ussd-hubtel/callbacks.test.ts
import { describe, it, expect, vi } from "vitest"
import { callbackDisposition, dispatchCallback, CALLBACK_WINDOW_MS } from "./callbacks"
import type { HubtelTxRow, HubtelTxStore } from "./types"

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

describe("callbackDisposition", () => {
  it("sends a fresh pending callback", () => {
    expect(callbackDisposition({ callback_status: "pending", paid_at: iso(NOW - 60_000) }, NOW)).toBe("send")
  })
  it("expires once the 55-minute safety window has passed (review focus #4)", () => {
    expect(callbackDisposition({ callback_status: "pending", paid_at: iso(NOW - CALLBACK_WINDOW_MS - 1) }, NOW)).toBe("expire")
  })
  it("skips anything that is not pending", () => {
    for (const s of ["sent", "failed", "not_due"] as const)
      expect(callbackDisposition({ callback_status: s, paid_at: iso(NOW) }, NOW)).toBe("skip")
  })
  it("treats a missing paid_at as fresh (sends)", () => {
    expect(callbackDisposition({ callback_status: "pending", paid_at: null }, NOW)).toBe("send")
  })
  it("missing paid_at falls back to created_at: older than 55 min -> expire (I3)", () => {
    expect(callbackDisposition({ callback_status: "pending", paid_at: null, created_at: iso(NOW - CALLBACK_WINDOW_MS - 60_000) }, NOW)).toBe("expire")
  })
  it("missing paid_at with a recent created_at still sends", () => {
    expect(callbackDisposition({ callback_status: "pending", paid_at: null, created_at: iso(NOW - 60_000) }, NOW)).toBe("send")
  })
})

function store(row: Partial<HubtelTxRow>) {
  let cur = { session_id: "S1", hubtel_order_id: "O1", callback_status: "pending", callback_attempts: 0, callback_last_error: null, callback_sent_at: null, paid_at: iso(NOW - 1000), ...row } as HubtelTxRow
  const s: HubtelTxStore = {
    findBySession: async () => cur,
    claim: async () => false,
    update: async (_id, p) => { cur = { ...cur, ...p } },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => [],
    listStaleProcessing: async () => [],
  }
  return { s, get: () => cur }
}

describe("dispatchCallback", () => {
  it("marks sent on success", async () => {
    const m = store({})
    const send = vi.fn().mockResolvedValue({ ok: true })
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("sent")
    expect(send).toHaveBeenCalledWith({ sessionId: "S1", orderId: "O1" })
    expect(m.get()).toMatchObject({ callback_status: "sent", callback_attempts: 1 })
    expect(m.get().callback_sent_at).toBeTruthy()
  })
  it("keeps pending and records the error on failure", async () => {
    const m = store({})
    const send = vi.fn().mockResolvedValue({ ok: false, error: "relay 502" })
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("retry")
    expect(m.get()).toMatchObject({ callback_status: "pending", callback_attempts: 1, callback_last_error: "relay 502" })
  })
  it("marks failed (and does not call the relay) after the window", async () => {
    const m = store({ paid_at: iso(NOW - CALLBACK_WINDOW_MS - 5) })
    const send = vi.fn()
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("expired")
    expect(send).not.toHaveBeenCalled()
    expect(m.get().callback_status).toBe("failed")
  })
  it("skips a row that is already sent", async () => {
    const m = store({ callback_status: "sent" })
    const send = vi.fn()
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("skipped")
    expect(send).not.toHaveBeenCalled()
  })
  it("fails the row when no Hubtel OrderId is known", async () => {
    const m = store({ hubtel_order_id: null })
    const send = vi.fn()
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("retry")
    expect(send).not.toHaveBeenCalled()
    expect(m.get().callback_last_error).toMatch(/order id/i)
  })
})
