import { describe, expect, it, vi } from "vitest"
import { fulfillAirtimeViaHubtel, HUBTEL_AIRTIME_MAX } from "./airtime-hubtel"
import { HubtelDuplicateOrderError, HubtelOutcomeUnknownError, HubtelPausedError, HubtelDisabledError } from "./hubtel-cs/errors"
import { makeTx } from "./hubtel-cs/testing/fixtures"

const order = (over: any = {}) => ({ id: "o1", reference_code: "AIR-1", network: "MTN", beneficiary_phone: "0241234567", airtime_amount: 5, ...over })
const deps = (purchase: any) => ({ purchase: vi.fn(purchase), markOrder: vi.fn(async () => {}), alert: vi.fn(async () => {}), refreshTx: vi.fn(async () => null), settle: vi.fn(async () => {}) }) as any

describe("fulfillAirtimeViaHubtel", () => {
  it("sends the right purchase and marks the order processing on pending", async () => {
    const d = deps(async () => makeTx({ state: "pending", client_reference: "HCS-airtime_mtn-1" }))
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.purchase).toHaveBeenCalledWith({ serviceKey: "airtime_mtn", destination: "0241234567", amount: 5, orderTable: "airtime_orders", orderId: "o1" })
    expect(d.markOrder).toHaveBeenCalledWith("o1", { status: "processing", notes: expect.stringContaining("HCS-airtime_mtn-1") }, ["pending"])
    expect(d.alert).not.toHaveBeenCalled()
  })
  it("over the cap: nothing sent, order left pending, admin alerted", async () => {
    const d = deps(async () => makeTx())
    expect(HUBTEL_AIRTIME_MAX).toBe(100)
    expect(await fulfillAirtimeViaHubtel(order({ airtime_amount: 100.01 }), d)).toBe(false)
    expect(d.purchase).not.toHaveBeenCalled()
    expect(d.markOrder).toHaveBeenCalledWith("o1", { notes: expect.stringMatching(/GHS 100/) })
    expect(d.alert).toHaveBeenCalledTimes(1)
  })
  it("exactly 100 is sent", async () => {
    const d = deps(async () => makeTx({ state: "pending" }))
    expect(await fulfillAirtimeViaHubtel(order({ airtime_amount: 100 }), d)).toBe(true)
  })
  it("paused or disabled: nothing sent, admin alerted, order stays pending", async () => {
    for (const err of [new HubtelPausedError("4075"), new HubtelDisabledError()]) {
      const d = deps(async () => { throw err })
      expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(false)
      expect(d.alert).toHaveBeenCalledTimes(1)
      expect(d.markOrder).toHaveBeenCalledWith("o1", { notes: expect.stringMatching(/not sent/i) })
    }
  })
  it("outcome unknown: order processing, alert, reported as handed off (never retried elsewhere)", async () => {
    const d = deps(async () => { throw new HubtelOutcomeUnknownError("HCS-airtime_mtn-9", new Error("db")) })
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.markOrder).toHaveBeenCalledWith("o1", { status: "processing", notes: expect.stringContaining("HCS-airtime_mtn-9") }, ["pending"])
    expect(d.alert).toHaveBeenCalledTimes(1)
  })
  it("needs_review result: processing + alert", async () => {
    const d = deps(async () => makeTx({ state: "needs_review", client_reference: "HCS-r" }))
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.markOrder).toHaveBeenCalledWith("o1", { status: "processing", notes: expect.stringContaining("HCS-r") }, ["pending"])
    expect(d.alert).toHaveBeenCalledTimes(1)
  })
  it("a live Hubtel transaction already exists: no-op success", async () => {
    const d = deps(async () => { throw new HubtelDuplicateOrderError("airtime_orders", "o1") })
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.alert).not.toHaveBeenCalled()
  })
  it("unknown network: not sent", async () => {
    const d = deps(async () => makeTx())
    expect(await fulfillAirtimeViaHubtel(order({ network: "Glo" }), d)).toBe(false)
    expect(d.purchase).not.toHaveBeenCalled()
  })
  it("pending POST on an order with NULL notes writes processing (status guard only)", async () => {
    const row: any = { status: "pending", notes: null }
    const d: any = deps(async () => makeTx({ state: "pending", client_reference: "HCS-n" }))
    d.markOrder = vi.fn(async (_id: string, patch: any, only?: string[]) => {
      if (only && !only.includes(row.status)) return
      Object.assign(row, patch)
    })
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.markOrder).toHaveBeenCalledWith("o1", expect.objectContaining({ status: "processing" }), ["pending"])
    expect(row.status).toBe("processing")
  })
  it("race: ledger already failed after the processing write -> settle called once with it", async () => {
    const d: any = deps(async () => makeTx({ state: "pending", client_reference: "HCS-r" }))
    const failed = makeTx({ state: "failed", client_reference: "HCS-r" })
    d.refreshTx = vi.fn(async () => failed); d.settle = vi.fn(async () => {})
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.refreshTx).toHaveBeenCalledWith("HCS-r")
    expect(d.settle).toHaveBeenCalledTimes(1)
    expect(d.settle).toHaveBeenCalledWith(failed)
  })
  it("race: ledger fulfilled -> settle called; still pending -> not called", async () => {
    const d: any = deps(async () => makeTx({ state: "pending" }))
    d.refreshTx = vi.fn(async () => makeTx({ state: "fulfilled" })); d.settle = vi.fn(async () => {})
    await fulfillAirtimeViaHubtel(order(), d)
    expect(d.settle).toHaveBeenCalledTimes(1)
    const p: any = deps(async () => makeTx({ state: "pending" }))
    p.refreshTx = vi.fn(async () => makeTx({ state: "pending" })); p.settle = vi.fn(async () => {})
    await fulfillAirtimeViaHubtel(order(), p)
    expect(p.settle).not.toHaveBeenCalled()
  })
  it("refreshTx throwing still returns true and never throws", async () => {
    const d: any = deps(async () => makeTx({ state: "pending" }))
    d.refreshTx = vi.fn(async () => { throw new Error("db") }); d.settle = vi.fn(async () => {})
    await expect(fulfillAirtimeViaHubtel(order(), d)).resolves.toBe(true)
    expect(d.settle).not.toHaveBeenCalled()
  })
  it("uses the review alert kind for unknown outcomes and no kind (manual) for not-sent", async () => {
    const u = deps(async () => { throw new HubtelOutcomeUnknownError("HCS-u", new Error("db")) })
    await fulfillAirtimeViaHubtel(order(), u)
    expect(u.alert).toHaveBeenCalledWith(expect.any(String), "review")
    const r = deps(async () => makeTx({ state: "needs_review" }))
    await fulfillAirtimeViaHubtel(order(), r)
    expect(r.alert).toHaveBeenCalledWith(expect.any(String), "review")
    const m = deps(async () => { throw new HubtelPausedError(null) })
    await fulfillAirtimeViaHubtel(order(), m)
    expect((m.alert.mock.calls[0] as any[])[1]).toBeUndefined()
  })
  it("never throws even if markOrder/alert fail", async () => {
    const d = { purchase: vi.fn(async () => { throw new HubtelPausedError(null) }), markOrder: vi.fn(async () => { throw new Error("db") }), alert: vi.fn(async () => { throw new Error("sms") }) } as any
    await expect(fulfillAirtimeViaHubtel(order(), d)).resolves.toBe(false)
  })
  describe("processing write failure after Hubtel accepted the order", () => {
    it("markOrder throws -> review alert 'do NOT resend', still returns true", async () => {
      const d = deps(async () => makeTx({ state: "pending", client_reference: "HCS-x" }))
      d.markOrder = vi.fn(async () => { throw new Error("db") })
      expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
      expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/could not be marked processing.*do NOT resend/), "review")
      expect(d.alert).toHaveBeenCalledWith(expect.stringContaining("HCS-x"), "review")
    })
    it("markOrder reports 0 rows and no terminal ledger -> review alert", async () => {
      const d = deps(async () => makeTx({ state: "created", client_reference: "HCS-y" }))
      d.markOrder = vi.fn(async () => 0)
      expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
      expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/do NOT resend/), "review")
    })
    it("0 rows because a terminal callback already settled the order -> settle, no alert", async () => {
      const d = deps(async () => makeTx({ state: "pending", client_reference: "HCS-z" }))
      d.markOrder = vi.fn(async () => 0)
      d.refreshTx = vi.fn(async () => makeTx({ state: "fulfilled", client_reference: "HCS-z" }))
      await fulfillAirtimeViaHubtel(order(), d)
      expect(d.settle).toHaveBeenCalledTimes(1)
      expect(d.alert).not.toHaveBeenCalled()
    })
    it("1 row updated -> no alert", async () => {
      const d = deps(async () => makeTx({ state: "pending" }))
      d.markOrder = vi.fn(async () => 1)
      await fulfillAirtimeViaHubtel(order(), d)
      expect(d.alert).not.toHaveBeenCalled()
    })
  })
})
