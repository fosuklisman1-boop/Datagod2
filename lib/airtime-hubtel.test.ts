import { describe, expect, it, vi } from "vitest"
import { fulfillAirtimeViaHubtel, HUBTEL_AIRTIME_MAX } from "./airtime-hubtel"
import { HubtelDuplicateOrderError, HubtelOutcomeUnknownError, HubtelPausedError, HubtelDisabledError } from "./hubtel-cs/errors"
import { makeTx } from "./hubtel-cs/testing/fixtures"

const order = (over: any = {}) => ({ id: "o1", reference_code: "AIR-1", network: "MTN", beneficiary_phone: "0241234567", airtime_amount: 5, ...over })
const deps = (purchase: any) => ({ purchase: vi.fn(purchase), markOrder: vi.fn(async () => {}), alert: vi.fn(async () => {}) }) as any

describe("fulfillAirtimeViaHubtel", () => {
  it("sends the right purchase and marks the order processing on pending", async () => {
    const d = deps(async () => makeTx({ state: "pending", client_reference: "HCS-airtime_mtn-1" }))
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.purchase).toHaveBeenCalledWith({ serviceKey: "airtime_mtn", destination: "0241234567", amount: 5, orderTable: "airtime_orders", orderId: "o1" })
    expect(d.markOrder).toHaveBeenCalledWith("o1", { status: "processing", notes: expect.stringContaining("HCS-airtime_mtn-1") })
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
    expect(d.markOrder).toHaveBeenCalledWith("o1", { status: "processing", notes: expect.stringContaining("HCS-airtime_mtn-9") })
    expect(d.alert).toHaveBeenCalledTimes(1)
  })
  it("needs_review result: processing + alert", async () => {
    const d = deps(async () => makeTx({ state: "needs_review", client_reference: "HCS-r" }))
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.markOrder).toHaveBeenCalledWith("o1", { status: "processing", notes: expect.stringContaining("HCS-r") })
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
  it("never throws even if markOrder/alert fail", async () => {
    const d = { purchase: vi.fn(async () => { throw new HubtelPausedError(null) }), markOrder: vi.fn(async () => { throw new Error("db") }), alert: vi.fn(async () => { throw new Error("sms") }) } as any
    await expect(fulfillAirtimeViaHubtel(order(), d)).resolves.toBe(false)
  })
})
