import { describe, expect, it, vi } from "vitest"
import { fulfillAirtimeViaHubtel, HUBTEL_AIRTIME_MAX, retryAirtimeViaHubtel } from "./airtime-hubtel"
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

describe("retryAirtimeViaHubtel", () => {
  const FAILED = "oldref"
  /** In-memory order with real status guards, so claim/revert behave like the DB. */
  const harness = (purchase: any, over: any = {}) => {
    const row: any = { ...order(), status: "pending", payment_status: "completed", notes: `Hubtel failed: x [hcsRef:${FAILED}]. Fulfil manually; not resent.`, ...over }
    const d: any = {
      getOrder: vi.fn(async () => ({ ...row })),
      markOrder: vi.fn(async (_id: string, patch: any, only: string[]) => {
        if (!only.includes(row.status)) return 0
        Object.assign(row, patch); return 1
      }),
      purchase: vi.fn(purchase),
      refreshTx: vi.fn(async () => null),
      settle: vi.fn(async () => {}),
      alert: vi.fn(async () => {}),
    }
    return { row, d }
  }

  it("claims the order BEFORE sending, then stamps the new ref", async () => {
    const { row, d } = harness(async () => {
      expect(row.status).toBe("processing") // claimed before the POST
      return makeTx({ state: "pending", client_reference: "newref" })
    })
    const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(out.ok).toBe(true)
    expect(d.purchase).toHaveBeenCalledWith({ serviceKey: "airtime_mtn", destination: "0241234567", amount: 5, orderTable: "airtime_orders", orderId: "o1" })
    expect(row.status).toBe("processing")
    expect(row.notes).toContain("hcsRef:newref")
  })

  it("refuses an order that is not pending (e.g. refunding/completed/processing) without sending", async () => {
    for (const status of ["processing", "completed", "refunding", "refunded", "failed"]) {
      const { d } = harness(async () => makeTx(), { status })
      const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
      expect(out).toMatchObject({ ok: false, status: 409 })
      expect(d.purchase).not.toHaveBeenCalled()
    }
  })

  it("refuses an unpaid order", async () => {
    const { d } = harness(async () => makeTx(), { payment_status: "pending" })
    expect((await retryAirtimeViaHubtel(d, "o1", FAILED)).ok).toBe(false)
    expect(d.purchase).not.toHaveBeenCalled()
  })

  it("refuses when the order was handled since this failure (notes no longer carry the failed ref)", async () => {
    const { d } = harness(async () => makeTx(), { notes: "Digiwapy error: timeout" })
    const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(out).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/handled since/i) })
    expect(d.purchase).not.toHaveBeenCalled()
  })

  it("loses the claim race (someone else moved the order) -> nothing sent", async () => {
    const { row, d } = harness(async () => makeTx())
    d.getOrder = vi.fn(async () => { const snap = { ...row }; row.status = "refunding"; return snap })
    const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(out).toMatchObject({ ok: false, status: 409 })
    expect(d.purchase).not.toHaveBeenCalled()
  })

  it("nothing sent (paused/disabled) -> order restored to pending with the old ref so it can be retried again", async () => {
    const { row, d } = harness(async () => { throw new HubtelPausedError("4075") })
    const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/not sent/i)
    expect(row.status).toBe("pending")
    expect(row.notes).toContain(`hcsRef:${FAILED}`)
  })

  it("outcome unknown -> stays processing with the new ref, review alert", async () => {
    const { row, d } = harness(async () => { throw new HubtelOutcomeUnknownError("unk", new Error("net")) })
    const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(out.ok).toBe(true)
    expect(row.status).toBe("processing")
    expect(row.notes).toMatch(/outcome unknown.*hcsRef:unk/i)
    expect(d.alert).toHaveBeenCalledWith(expect.any(String), "review")
  })

  it("a live transaction already exists -> left processing, review alert, reported as not retried", async () => {
    const { row, d } = harness(async () => { throw new HubtelDuplicateOrderError("airtime_orders", "o1") })
    const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(out).toMatchObject({ ok: false, status: 409 })
    expect(row.status).toBe("processing")
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/do not resend/i), "review")
  })

  it("Hubtel fails again synchronously -> ledger re-applied so the order returns to pending with the NEW ref", async () => {
    const failedAgain = makeTx({ state: "failed", client_reference: "newref", order_table: "airtime_orders", order_id: "o1" })
    const { d } = harness(async () => failedAgain)
    d.refreshTx = vi.fn(async () => failedAgain)
    const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(d.settle).toHaveBeenCalledWith(failedAgain)
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/failed again/i)
  })

  it("delivered -> settle applied, ok", async () => {
    const done = makeTx({ state: "fulfilled", client_reference: "newref" })
    const { d } = harness(async () => done)
    d.refreshTx = vi.fn(async () => done)
    const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(out.ok).toBe(true)
    expect(d.settle).toHaveBeenCalledWith(done)
  })

  it("stamp write fails after the send -> admins alerted that the order needs reconciling (never silent)", async () => {
    const { row, d } = harness(async () => makeTx({ state: "pending", client_reference: "newref" }))
    const real = d.markOrder
    d.markOrder = vi.fn(async (id: string, patch: any, only: string[]) => (patch.status ? real(id, patch, only) : Promise.reject(new Error("db"))))
    await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(row.status).toBe("processing")
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/reconcile/i), "review")
    expect(d.alert).toHaveBeenCalledWith(expect.stringContaining("newref"), "review")
  })

  it("ledger re-read fails after the send -> admins alerted to reconcile", async () => {
    const { d } = harness(async () => makeTx({ state: "pending", client_reference: "newref" }))
    d.refreshTx = vi.fn(async () => { throw new Error("db") })
    const out = await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(out.ok).toBe(true)
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/reconcile/i), "review")
  })

  it("duplicate live transaction -> alert says the order is left processing and must be reconciled", async () => {
    const { d } = harness(async () => { throw new HubtelDuplicateOrderError("airtime_orders", "o1") })
    await retryAirtimeViaHubtel(d, "o1", FAILED)
    expect(d.alert).toHaveBeenCalledWith(expect.stringMatching(/processing.*reconcile/i), "review")
  })

  it("unsupported network / over the cap -> refused before any claim", async () => {
    for (const over of [{ network: "Glo" }, { airtime_amount: 150 }]) {
      const { row, d } = harness(async () => makeTx(), over)
      expect((await retryAirtimeViaHubtel(d, "o1", FAILED)).ok).toBe(false)
      expect(d.purchase).not.toHaveBeenCalled()
      expect(row.status).toBe("pending")
    }
  })
})
