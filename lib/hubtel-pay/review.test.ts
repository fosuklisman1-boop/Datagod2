import { describe, expect, it, vi } from "vitest"
import { checkManualRefund, classifySecondPayment, fulfilPayment, fulfilRefusal, listReview, markPaymentFailed, markRefundedManually, reasonOf, recheckPayment, supabaseReviewStore, type OrderPaymentFacts, type ReviewDeps, type ReviewRow } from "./review"
import type { PaymentStatus } from "./client"

const REF = "0123456789abcdef0123456789abcdef"
const NOW = new Date("2026-11-05T12:00:00Z")

const baseRow = (o: Partial<ReviewRow> = {}): ReviewRow => ({
  reference: REF, internal_reference: "WALLET-1", surface: "wallet_topup", amount_pesewas: 100, handler_amount_pesewas: null,
  metadata: { gateway: "hubtel" }, status: "needs_review", last_check: null, created_at: "2026-11-05T11:00:00Z", claimed_at: null, ...o,
})
// Live test 2026-11-05: asked 1.00, status check said amount 1.01, charges 0.01.
const paid = (o: Partial<PaymentStatus> = {}): PaymentStatus => ({ kind: "paid", amountPesewas: 101, chargesPesewas: 1, paymentMethod: "mobilemoney", transactionId: "t1", raw: { status: "Paid" }, ...o })

/** In-memory store. take() checks and sets before any await, like the single conditional UPDATE it stands for. */
function setup(row: ReviewRow | null, status: PaymentStatus = paid(), o: { paidSibling?: boolean; order?: OrderPaymentFacts | null; handler?: () => Promise<Response | null> } = {}) {
  const rows = new Map<string, ReviewRow>(row ? [[row.reference, { ...row }]] : [])
  let claims = 0
  const updates: { patch: any; guard: any }[] = []
  const onChargeSuccess = vi.fn(o.handler ?? (async () => new Response(JSON.stringify({ received: true }), { status: 200 })))
  const log = vi.fn()
  const deps: ReviewDeps = {
    now: () => NOW,
    checkStatus: async () => status,
    onChargeSuccess,
    log,
    store: {
      listOpen: async () => [...rows.values()],
      load: async (r) => (rows.has(r) ? { ...rows.get(r)! } : null),
      take: (r) => {
        const cur = rows.get(r.reference)
        if (!cur || cur.status !== r.status || (r.status === "confirming" && cur.claimed_at !== r.claimed_at)) return Promise.resolve(null)
        const at = `claim-${++claims}`
        rows.set(r.reference, { ...cur, status: "confirming", claimed_at: at })
        return Promise.resolve(at)
      },
      update: async (r, patch, guard) => {
        updates.push({ patch, guard })
        const cur = rows.get(r)
        if (!cur || !guard.status.includes(cur.status) || (guard.claimedAt !== undefined && cur.claimed_at !== guard.claimedAt)) return false
        rows.set(r, { ...cur, ...(patch as any) })
        return true
      },
      hasPaidSibling: async () => !!o.paidSibling,
      orderPaymentFacts: async () => o.order ?? null,
    },
  }
  return { deps, rows, onChargeSuccess, updates, log }
}

describe("fulfilPayment", () => {
  it("two concurrent clicks: one handler call, one paid write, the other click is told someone else has it", async () => {
    const { deps, rows, onChargeSuccess } = setup(baseRow())
    const [a, b] = await Promise.all([fulfilPayment(deps, REF, "admin-1"), fulfilPayment(deps, REF, "admin-2")])
    expect(onChargeSuccess).toHaveBeenCalledTimes(1)
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(rows.get(REF)!.status).toBe("paid")
  })

  it("a second click after it is paid is refused before any status check or handler", async () => {
    const { deps, onChargeSuccess } = setup(baseRow())
    await fulfilPayment(deps, REF, "a")
    const again = await fulfilPayment(deps, REF, "a")
    expect(again).toMatchObject({ ok: false, status: 409 })
    expect(onChargeSuccess).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["unpaid", { kind: "unpaid" } as Partial<PaymentStatus>],
    ["not_found", { kind: "not_found" } as Partial<PaymentStatus>],
    ["error", { kind: "error" } as Partial<PaymentStatus>],
    ["refunded", { kind: "refunded" } as Partial<PaymentStatus>],
  ])("refused when Hubtel says %s; the row is not touched", async (_n, s) => {
    const { deps, rows, onChargeSuccess, updates } = setup(baseRow(), paid(s))
    expect(await fulfilPayment(deps, REF, "a")).toMatchObject({ ok: false, status: 409 })
    expect(onChargeSuccess).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
    expect(rows.get(REF)!.status).toBe("needs_review")
  })

  it("the charge sits on top: gross 1.01 with 0.01 charge passes for 1.00 requested; gross 1.00 with 0.01 charge does not", async () => {
    expect(fulfilRefusal({ amount_pesewas: 100 }, paid())).toBeNull()
    expect(fulfilRefusal({ amount_pesewas: 100 }, paid({ amountPesewas: 100, chargesPesewas: 1 }))).toMatch(/less than/)
    expect(fulfilRefusal({ amount_pesewas: 100 }, paid({ amountPesewas: 99, chargesPesewas: 0 }))).toMatch(/less than/)
    expect(fulfilRefusal({ amount_pesewas: 100 }, paid({ chargesPesewas: undefined }))).toMatch(/charge/)
    expect(fulfilRefusal({ amount_pesewas: 100 }, paid({ amountPesewas: undefined }))).toMatch(/amount/)
    expect(fulfilRefusal({ amount_pesewas: 100 }, paid({ paymentMethod: "card" }))).toMatch(/method/)
  })

  it("the handler gets our amount (the full price when the merchant bears the fee), never Hubtel's gross", async () => {
    const { deps, onChargeSuccess } = setup(baseRow({ amount_pesewas: 98, handler_amount_pesewas: 100 }), paid({ amountPesewas: 99, chargesPesewas: 1 }))
    await fulfilPayment(deps, REF, "a")
    expect(onChargeSuccess).toHaveBeenCalledWith(expect.objectContaining({ reference: "WALLET-1", amount: 100, metadata: { gateway: "hubtel" } }))
  })

  it("a paid sibling (customer paid twice) is refused", async () => {
    const { deps, onChargeSuccess } = setup(baseRow(), paid(), { paidSibling: true })
    expect(await fulfilPayment(deps, REF, "a")).toMatchObject({ ok: false, message: expect.stringMatching(/paid twice/) })
    expect(onChargeSuccess).not.toHaveBeenCalled()
  })

  it("a handler that fails or reports the order closed puts the row back in review, never paid", async () => {
    for (const handler of [
      async () => { throw new Error("x") },
      async () => new Response("{}", { status: 500 }),
      async () => new Response(JSON.stringify({ received: true, order_closed: true }), { status: 200 }),
    ]) {
      const { deps, rows } = setup(baseRow(), paid(), { handler })
      expect((await fulfilPayment(deps, REF, "a")).ok).toBe(false)
      expect(rows.get(REF)!.status).toBe("needs_review")
    }
  })

  it("a late payment on a closed order: confirmed held, marked paid so the refund tool can return it, nothing delivered", async () => {
    const handler = async () => new Response(JSON.stringify({ received: true, order_closed: true, closed_reason: "late_payment" }), { status: 200 })
    const { deps, rows } = setup(baseRow(), paid(), { handler })
    const out = await fulfilPayment(deps, REF, "a")
    expect(out.ok).toBe(true)
    expect(out.message).toMatch(/refund/i)
    expect(rows.get(REF)!.status).toBe("paid")
  })

  it("a stale confirming row can be fulfilled; a fresh claim and other statuses cannot", async () => {
    const stale = setup(baseRow({ status: "confirming", claimed_at: "2026-11-05T11:40:00Z" }))
    expect((await fulfilPayment(stale.deps, REF, "a")).ok).toBe(true)
    for (const r of [baseRow({ status: "confirming", claimed_at: "2026-11-05T11:55:00Z" }), baseRow({ status: "pending" }), baseRow({ status: "paid" }), baseRow({ status: "failed" })]) {
      const s = setup(r)
      expect(await fulfilPayment(s.deps, REF, "a")).toMatchObject({ ok: false, status: 409 })
      expect(s.onChargeSuccess).not.toHaveBeenCalled()
    }
  })

  it("logs the admin id and the reference only", async () => {
    const { deps, log } = setup(baseRow())
    await fulfilPayment(deps, REF, "admin-9")
    expect(log).toHaveBeenCalledWith("fulfil_done", expect.objectContaining({ adminId: "admin-9", reference: REF }))
    for (const [, fields] of log.mock.calls) expect(Object.keys(fields)).not.toContain("msisdn")
  })

  it("rejects a malformed or unknown reference", async () => {
    const { deps } = setup(null)
    expect(await fulfilPayment(deps, "WALLET-1", "a")).toMatchObject({ ok: false, status: 400 })
    expect(await fulfilPayment(deps, REF, "a")).toMatchObject({ ok: false, status: 404 })
  })
})

describe("markPaymentFailed", () => {
  it("closes the row when Hubtel does not say Paid", async () => {
    const { deps, rows } = setup(baseRow(), paid({ kind: "unpaid" }))
    expect((await markPaymentFailed(deps, REF, "a")).ok).toBe(true)
    expect(rows.get(REF)!.status).toBe("failed")
  })
  it("refused when Hubtel says Paid or the check errors", async () => {
    for (const s of [paid(), paid({ kind: "error" })]) {
      const { deps, rows } = setup(baseRow(), s)
      expect((await markPaymentFailed(deps, REF, "a")).ok).toBe(false)
      expect(rows.get(REF)!.status).toBe("needs_review")
    }
  })
  it("never calls the success handler", async () => {
    const { deps, onChargeSuccess } = setup(baseRow(), paid({ kind: "not_found" }))
    await markPaymentFailed(deps, REF, "a")
    expect(onChargeSuccess).not.toHaveBeenCalled()
  })
  it("closes the leftover wallet row under its internal reference, after the Hubtel row is failed", async () => {
    const { deps, rows } = setup(baseRow(), paid({ kind: "unpaid" }))
    const closeWalletPayment = vi.fn(async () => { expect(rows.get(REF)!.status).toBe("failed") })
    await markPaymentFailed({ ...deps, closeWalletPayment }, REF, "a")
    expect(closeWalletPayment).toHaveBeenCalledExactlyOnceWith("WALLET-1")
  })
  it("uses the opaque reference when the row has no internal reference", async () => {
    const { deps } = setup(baseRow({ internal_reference: null }), paid({ kind: "unpaid" }))
    const closeWalletPayment = vi.fn(async () => {})
    await markPaymentFailed({ ...deps, closeWalletPayment }, REF, "a")
    expect(closeWalletPayment).toHaveBeenCalledExactlyOnceWith(REF)
  })
  it("leaves the wallet row alone when Hubtel says Paid or the check errors", async () => {
    for (const s of [paid(), paid({ kind: "error" })]) {
      const { deps } = setup(baseRow(), s)
      const closeWalletPayment = vi.fn(async () => {})
      await markPaymentFailed({ ...deps, closeWalletPayment }, REF, "a")
      expect(closeWalletPayment).not.toHaveBeenCalled()
    }
  })
  it("a failure closing the wallet row doesn't undo the result", async () => {
    const { deps } = setup(baseRow(), paid({ kind: "unpaid" }))
    const closeWalletPayment = vi.fn(async () => { throw new Error("db down") })
    expect((await markPaymentFailed({ ...deps, closeWalletPayment }, REF, "a")).ok).toBe(true)
  })
})

/** The order facts of a shop order: paid by something else, this payment's own wallet row still open. */
const orderFacts = (o: Partial<OrderPaymentFacts> = {}): OrderPaymentFacts => ({
  orderStatus: "completed", paymentStatus: "completed", ownPaymentCompleted: false, otherPaymentCompleted: true, refundCompleted: false, ...o,
})
const FORM = { adminReference: "MP241105.1234.A56789", note: "Paid back by MoMo after a double payment" }

describe("classifySecondPayment", () => {
  const c = (order: OrderPaymentFacts | null, paidSibling = false) => classifySecondPayment({ paidSibling, order })

  it("the I4 read: completed by something other than this reference is a second payment", () => {
    expect(c(orderFacts())).toBe("second")
    expect(c(orderFacts({ otherPaymentCompleted: false }))).toBe("second") // paid from the wallet: no other wallet_payments row
    expect(c(orderFacts({ ownPaymentCompleted: true }))).toBe("second")
  })
  it("completed by this reference alone is the order's only payment", () => {
    expect(c(orderFacts({ ownPaymentCompleted: true, otherPaymentCompleted: false }))).toBe("not_second")
  })
  it("unpaid or unknown orders with nothing else paid are not second payments", () => {
    expect(c(orderFacts({ orderStatus: "pending", paymentStatus: "pending", otherPaymentCompleted: false }))).toBe("not_second")
    expect(c(orderFacts({ orderStatus: "expired", paymentStatus: "expired", otherPaymentCompleted: false }))).toBe("not_second")
    expect(c(null)).toBe("not_second")
  })
  it("another attempt already paid is a second payment, whatever the order says or when there is no order", () => {
    expect(c(null, true)).toBe("second")
    expect(c(orderFacts({ orderStatus: "expired", paymentStatus: "expired", otherPaymentCompleted: false }), true)).toBe("second")
  })
  it("two late payments on a closed order: the other one holds money too", () => {
    expect(c(orderFacts({ orderStatus: "expired", paymentStatus: "expired", ownPaymentCompleted: true }))).toBe("second")
    // A pending order is not closed: this is a stray row, not two late payments.
    expect(c(orderFacts({ orderStatus: "pending", paymentStatus: "pending", ownPaymentCompleted: true }))).toBe("not_second")
  })
  it("a refunded order qualifies only when this money is clearly separate from what was refunded", () => {
    const refunded = { orderStatus: "refunded", refundCompleted: true }
    expect(c(orderFacts({ ...refunded, paymentStatus: "expired", ownPaymentCompleted: true }))).toBe("second")
    expect(c(orderFacts({ ...refunded, paymentStatus: "completed", otherPaymentCompleted: false }))).toBe("second") // paid from the wallet
    expect(c(orderFacts({ orderStatus: "refunded", refundCompleted: true, paymentStatus: "expired", ownPaymentCompleted: true, otherPaymentCompleted: false }), true)).toBe("second")
    // Nothing else shows up, so this could be the money that was refunded.
    expect(c(orderFacts({ ...refunded, paymentStatus: "expired", ownPaymentCompleted: true, otherPaymentCompleted: false }))).toBe("unclear")
    expect(c(orderFacts({ ...refunded, paymentStatus: "completed", ownPaymentCompleted: true, otherPaymentCompleted: false }))).toBe("unclear")
    // Marked refunded with no completed refund on record.
    expect(c(orderFacts({ orderStatus: "refunded", refundCompleted: false, paymentStatus: "expired", ownPaymentCompleted: true }))).toBe("unclear")
  })
  it("a refund still running decides first, even with a paid sibling", () => {
    expect(c(orderFacts({ orderStatus: "refunding" }))).toBe("refund_running")
    expect(c(orderFacts({ orderStatus: "refunding" }), true)).toBe("refund_running")
  })
})

describe("markRefundedManually", () => {
  const run = (deps: ReviewDeps, form: { adminReference: unknown; note: unknown } = FORM, admin = "admin-1") => markRefundedManually(deps, REF, admin, form)

  it("records a second payment: terminal status, the admin's reference and note on the row, the fresh check, no handler", async () => {
    const { deps, rows, onChargeSuccess } = setup(baseRow(), paid(), { order: orderFacts() })
    const out = await run(deps)
    expect(out).toMatchObject({ ok: true, check: { kind: "paid" } })
    const stored: any = rows.get(REF)!
    expect(stored.status).toBe("refunded_manually")
    expect(stored.manual_refund).toEqual({ admin_reference: FORM.adminReference, note: FORM.note, admin_id: "admin-1", recorded_at: NOW.toISOString() })
    expect(stored.last_check).toEqual({ status: "Paid" })
    expect(stored.hubtel_transaction_id).toBe("t1")
    expect(onChargeSuccess).not.toHaveBeenCalled()
  })

  it("trims what the admin typed", async () => {
    const { deps, rows } = setup(baseRow(), paid(), { order: orderFacts() })
    await run(deps, { adminReference: `  ${FORM.adminReference} `, note: ` ${FORM.note}\n` })
    expect((rows.get(REF)! as any).manual_refund).toMatchObject({ admin_reference: FORM.adminReference, note: FORM.note })
  })

  it("closes this payment's wallet row under its internal reference, after the status is written", async () => {
    const { deps, rows } = setup(baseRow(), paid(), { order: orderFacts() })
    const closeWalletPayment = vi.fn(async () => { expect(rows.get(REF)!.status).toBe("refunded_manually") })
    await run({ ...deps, closeWalletPayment })
    expect(closeWalletPayment).toHaveBeenCalledExactlyOnceWith("WALLET-1")
  })

  it("uses the opaque reference for the wallet row when the row has no internal reference", async () => {
    const { deps } = setup(baseRow({ internal_reference: null }), paid(), { order: orderFacts() })
    const closeWalletPayment = vi.fn(async () => {})
    await run({ ...deps, closeWalletPayment })
    expect(closeWalletPayment).toHaveBeenCalledExactlyOnceWith(REF)
  })

  it("a failure closing the wallet row doesn't undo the result", async () => {
    const { deps, rows } = setup(baseRow(), paid(), { order: orderFacts() })
    expect((await run({ ...deps, closeWalletPayment: async () => { throw new Error("db down") } })).ok).toBe(true)
    expect(rows.get(REF)!.status).toBe("refunded_manually")
  })

  it("two concurrent clicks: one write, one wallet close, the other click is refused", async () => {
    const { deps, rows } = setup(baseRow(), paid(), { order: orderFacts() })
    const closeWalletPayment = vi.fn(async () => {})
    const d = { ...deps, closeWalletPayment }
    const [a, b] = await Promise.all([run(d, FORM, "admin-1"), run(d, FORM, "admin-2")])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ status: 409 })
    expect(closeWalletPayment).toHaveBeenCalledTimes(1)
    expect((rows.get(REF)! as any).manual_refund.admin_id).toBe(a.ok ? "admin-1" : "admin-2")
  })

  it("the write is guarded on needs_review, and a Fulfil that took the row first wins", async () => {
    const { deps, rows, updates } = setup(baseRow(), paid(), { order: orderFacts() })
    const closeWalletPayment = vi.fn(async () => {})
    const realCheck = deps.checkStatus
    // Fulfil takes the row while the status check is in flight.
    const checkStatus = async (r: string) => { rows.set(REF, { ...rows.get(REF)!, status: "confirming", claimed_at: "c1" }); return realCheck(r) }
    expect(await run({ ...deps, checkStatus, closeWalletPayment })).toMatchObject({ ok: false, status: 409 })
    expect(updates[0].guard).toEqual({ status: ["needs_review"] })
    expect(rows.get(REF)!.status).toBe("confirming")
    expect(closeWalletPayment).not.toHaveBeenCalled()
  })

  it.each([
    ["unpaid", { kind: "unpaid" }, 409],
    ["not_found", { kind: "not_found" }, 409],
    ["refunded", { kind: "refunded" }, 409],
    ["error", { kind: "error" }, 502],
  ] as [string, Partial<PaymentStatus>, number][])("refused when the fresh check says %s; nothing is written", async (_n, s, http) => {
    const { deps, rows, updates } = setup(baseRow(), paid(s), { order: orderFacts() })
    const closeWalletPayment = vi.fn(async () => {})
    expect(await run({ ...deps, closeWalletPayment })).toMatchObject({ ok: false, status: http })
    expect(updates).toHaveLength(0)
    expect(rows.get(REF)!.status).toBe("needs_review")
    expect(closeWalletPayment).not.toHaveBeenCalled()
  })

  it.each([
    ["completed by this reference alone", orderFacts({ ownPaymentCompleted: true, otherPaymentCompleted: false }), /only payment/],
    ["an order nothing paid", orderFacts({ orderStatus: "pending", paymentStatus: "pending", otherPaymentCompleted: false }), /only payment/],
    ["no shop order", null, /only payment/],
    ["refunded and can't tell", orderFacts({ orderStatus: "refunded", refundCompleted: true, paymentStatus: "expired", ownPaymentCompleted: true, otherPaymentCompleted: false }), /can't show/],
    ["a refund running", orderFacts({ orderStatus: "refunding" }), /refund is running/],
  ] as [string, OrderPaymentFacts | null, RegExp][])("refused: %s", async (_n, order, message) => {
    const { deps, rows, updates } = setup(baseRow(), paid(), { order })
    const out = await run(deps)
    expect(out).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(message) })
    expect(updates).toHaveLength(0)
    expect(rows.get(REF)!.status).toBe("needs_review")
  })

  it("a paid sibling on a wallet top-up (no order) qualifies: the case Fulfil sends here", async () => {
    const { deps, rows } = setup(baseRow(), paid(), { paidSibling: true })
    expect((await run(deps)).ok).toBe(true)
    expect(rows.get(REF)!.status).toBe("refunded_manually")
  })

  it("N4: a second late payment on an already refunded order qualifies when the money is clearly separate", async () => {
    const { deps, rows } = setup(baseRow(), paid(), { order: orderFacts({ orderStatus: "refunded", paymentStatus: "expired", refundCompleted: true, ownPaymentCompleted: true }) })
    expect((await run(deps)).ok).toBe(true)
    expect(rows.get(REF)!.status).toBe("refunded_manually")
  })

  it("an underpaid or card payment can still be recorded: what was paid went back, the fulfil rules don't apply", async () => {
    const { deps } = setup(baseRow(), paid({ amountPesewas: 50, paymentMethod: "card" }), { order: orderFacts() })
    expect((await run(deps)).ok).toBe(true)
  })

  it.each([
    ["no reference", { adminReference: undefined, note: FORM.note }],
    ["no note", { adminReference: FORM.adminReference, note: undefined }],
    ["blank reference", { adminReference: "   ", note: FORM.note }],
    ["blank note", { adminReference: FORM.adminReference, note: " \n " }],
    ["short reference", { adminReference: "abc", note: FORM.note }],
    ["short note", { adminReference: FORM.adminReference, note: "ok" }],
    ["long reference", { adminReference: "x".repeat(101), note: FORM.note }],
    ["long note", { adminReference: FORM.adminReference, note: "x".repeat(501) }],
    ["control characters", { adminReference: "abc\u0000def", note: FORM.note }],
    ["a line break in the reference", { adminReference: "abc\ndef", note: FORM.note }],
    ["non-strings", { adminReference: 12345, note: { a: 1 } }],
  ] as [string, { adminReference: unknown; note: unknown }][])("400 on %s, before any status check", async (_n, form) => {
    const { deps } = setup(baseRow(), paid(), { order: orderFacts() })
    const checkStatus = vi.fn(deps.checkStatus)
    expect(await run({ ...deps, checkStatus }, form)).toMatchObject({ ok: false, status: 400 })
    expect(checkStatus).not.toHaveBeenCalled()
  })

  it("only a needs_review row: refused before any status check for every other status, including a stale claim and a second click", async () => {
    for (const r of [
      baseRow({ status: "confirming", claimed_at: "2026-11-05T11:40:00Z" }), baseRow({ status: "pending" }), baseRow({ status: "paid" }),
      baseRow({ status: "failed" }), baseRow({ status: "refunded_manually" as any }),
    ]) {
      const { deps, updates } = setup(r, paid(), { order: orderFacts() })
      const checkStatus = vi.fn(deps.checkStatus)
      expect(await run({ ...deps, checkStatus })).toMatchObject({ ok: false, status: 409 })
      expect(checkStatus).not.toHaveBeenCalled()
      expect(updates).toHaveLength(0)
    }
  })

  it("rejects a malformed or unknown reference", async () => {
    const { deps } = setup(null)
    expect(await markRefundedManually(deps, "WALLET-1", "a", FORM)).toMatchObject({ ok: false, status: 400 })
    expect(await markRefundedManually(deps, REF, "a", FORM)).toMatchObject({ ok: false, status: 404 })
  })

  it("logs the admin id and the opaque reference only: never what the admin typed", async () => {
    const { deps, log } = setup(baseRow(), paid(), { order: orderFacts() })
    await run(deps, FORM, "admin-9")
    expect(log).toHaveBeenCalledWith("refunded_manually", expect.objectContaining({ adminId: "admin-9", reference: REF }))
    const logged = JSON.stringify(log.mock.calls)
    expect(logged).not.toContain(FORM.adminReference)
    expect(logged).not.toContain(FORM.note)
  })

  it("the result message never echoes what the admin typed (the route writes it to the audit log)", async () => {
    const { deps } = setup(baseRow(), paid(), { order: orderFacts() })
    const out = await run(deps)
    expect(out.message).not.toContain(FORM.adminReference)
    expect(out.message).not.toContain(FORM.note)
  })

  it("a failed order read stops it: nothing written, the error reaches the route", async () => {
    const { deps, rows, updates } = setup(baseRow(), paid())
    deps.store.orderPaymentFacts = async () => { throw new Error("boom") }
    await expect(run(deps)).rejects.toThrow("boom")
    expect(updates).toHaveLength(0)
    expect(rows.get(REF)!.status).toBe("needs_review")
  })
})

describe("a refunded_manually row is closed for good", () => {
  const closed = () => baseRow({ status: "refunded_manually" as any })

  it("can't be fulfilled, re-checked or marked failed, and the handler is never called", async () => {
    const { deps, onChargeSuccess, updates } = setup(closed())
    for (const action of [fulfilPayment, recheckPayment, markPaymentFailed]) {
      expect(await action(deps, REF, "a")).toMatchObject({ ok: false, status: 409 })
    }
    expect(onChargeSuccess).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })
})

describe("Fulfil points a second payment at the exit", () => {
  const POINTER = /Refunded outside the app/

  it("N7: a paid sibling says how to get out, instead of 'refund this one'", async () => {
    const { deps, onChargeSuccess } = setup(baseRow(), paid(), { paidSibling: true })
    const out = await fulfilPayment(deps, REF, "a")
    expect(out).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(POINTER) })
    expect(out.message).toMatch(/paid twice/)
    expect(out.message).not.toMatch(/refund this one/)
    expect(onChargeSuccess).not.toHaveBeenCalled()
  })

  it("N4: a second late payment on a refunded order stays in review: never recorded paid, where the refund tool would refuse it", async () => {
    const handler = async () => new Response(JSON.stringify({ received: true, order_closed: true, closed_reason: "late_payment" }), { status: 200 })
    const { deps, rows, onChargeSuccess } = setup(baseRow(), paid(), {
      handler, order: orderFacts({ orderStatus: "refunded", paymentStatus: "expired", refundCompleted: true, ownPaymentCompleted: true }),
    })
    const out = await fulfilPayment(deps, REF, "a")
    expect(out).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(POINTER) })
    expect(rows.get(REF)!.status).toBe("needs_review")
    expect(onChargeSuccess).not.toHaveBeenCalled()
  })

  it("two late payments on a closed order: the second stays in review", async () => {
    const { deps, rows } = setup(baseRow(), paid(), { order: orderFacts({ orderStatus: "expired", paymentStatus: "expired", ownPaymentCompleted: true }) })
    expect(await fulfilPayment(deps, REF, "a")).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(POINTER) })
    expect(rows.get(REF)!.status).toBe("needs_review")
  })

  it("a refund running or a refunded order it can't place: refused, left in review, handler not called", async () => {
    for (const order of [
      orderFacts({ orderStatus: "refunding" }),
      orderFacts({ orderStatus: "refunded", refundCompleted: true, paymentStatus: "expired", ownPaymentCompleted: true, otherPaymentCompleted: false }),
    ]) {
      const { deps, rows, onChargeSuccess } = setup(baseRow(), paid(), { order })
      expect(await fulfilPayment(deps, REF, "a")).toMatchObject({ ok: false, status: 409 })
      expect(rows.get(REF)!.status).toBe("needs_review")
      expect(onChargeSuccess).not.toHaveBeenCalled()
    }
  })

  it("unchanged: a first late payment on a closed order is still recorded paid, for the refund tool", async () => {
    const handler = async () => new Response(JSON.stringify({ received: true, order_closed: true, closed_reason: "late_payment" }), { status: 200 })
    const { deps, rows } = setup(baseRow(), paid(), { handler, order: orderFacts({ orderStatus: "expired", paymentStatus: "expired", ownPaymentCompleted: true, otherPaymentCompleted: false }) })
    expect(await fulfilPayment(deps, REF, "a")).toMatchObject({ ok: true, message: expect.stringMatching(/admin\/refunds/) })
    expect(rows.get(REF)!.status).toBe("paid")
  })

  it("unchanged: an ordinary unpaid order is fulfilled", async () => {
    const { deps, rows, onChargeSuccess } = setup(baseRow(), paid(), { order: orderFacts({ orderStatus: "pending", paymentStatus: "pending", otherPaymentCompleted: false }) })
    expect((await fulfilPayment(deps, REF, "a")).ok).toBe(true)
    expect(onChargeSuccess).toHaveBeenCalledTimes(1)
    expect(rows.get(REF)!.status).toBe("paid")
  })

  it("the order-closed answer no longer dead-ends on 'refund it'", async () => {
    const handler = async () => new Response(JSON.stringify({ received: true, order_closed: true }), { status: 200 })
    const { deps } = setup(baseRow(), paid(), { handler })
    const out = await fulfilPayment(deps, REF, "a")
    expect(out).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(POINTER) })
  })

  it("Mark failed on a Paid row points at the exit too", async () => {
    const { deps } = setup(baseRow(), paid())
    expect(await markPaymentFailed(deps, REF, "a")).toMatchObject({ ok: false, message: expect.stringMatching(POINTER) })
  })
})

describe("supabaseReviewStore.orderPaymentFacts", () => {
  type Tables = Record<string, Record<string, unknown>[]>
  /** eq/neq/in filters over in-memory tables, with an optional error per table. */
  function fakeSb(tables: Tables, errors: Record<string, string> = {}) {
    const from = (table: string) => {
      const filters: ((r: Record<string, unknown>) => boolean)[] = []
      const finish = () => {
        if (errors[table]) return { data: null, error: { code: "57014", message: errors[table] } }
        return { data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }
      }
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q },
        neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return q },
        in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q },
        limit: () => q,
        maybeSingle: async () => { const f = finish(); return { data: f.data?.[0] ?? null, error: f.error } },
        then: (ok: (v: unknown) => unknown) => Promise.resolve(finish()).then(ok),
      }
      return q
    }
    return { from } as any
  }
  const OWN = { reference: "WALLET-2", status: "pending", order_id: "o1", order_type: "shop_order" }
  const OTHER = { reference: "WALLET-1", status: "completed", order_id: "o1", order_type: "shop_order" }
  const ORDER = { id: "o1", order_status: "completed", payment_status: "completed" }

  it("reads the order, this payment and the others", async () => {
    const sb = fakeSb({ wallet_payments: [OWN, OTHER], shop_orders: [ORDER], order_refunds: [] })
    expect(await supabaseReviewStore(sb).orderPaymentFacts("WALLET-2", null)).toEqual({
      orderStatus: "completed", paymentStatus: "completed", ownPaymentCompleted: false, otherPaymentCompleted: true, refundCompleted: false,
    })
  })

  // The handler completes the wallet row, then the order. A wallet read older than the order read could show an order
  // completed by this very payment as "paid elsewhere", and an only payment as a second one.
  it("a payment settling during the reads is seen as this payment's own, not another", async () => {
    const tables: Tables = { wallet_payments: [{ ...OWN }], shop_orders: [ORDER], order_refunds: [] }
    const sb = fakeSb(tables)
    const from = sb.from
    // A new row object, so a read taken before the order read keeps the old status, as a real database reply would.
    sb.from = (table: string) => { if (table === "shop_orders") tables.wallet_payments = [{ ...OWN, status: "completed" }]; return from(table) }
    const facts = await supabaseReviewStore(sb).orderPaymentFacts("WALLET-2", null)
    expect(facts).toMatchObject({ ownPaymentCompleted: true, otherPaymentCompleted: false })
    expect(classifySecondPayment({ paidSibling: false, order: facts })).toBe("not_second")
  })

  it("this reference's own completed row is not 'another payment'", async () => {
    const sb = fakeSb({ wallet_payments: [{ ...OWN, status: "completed" }], shop_orders: [ORDER] })
    expect(await supabaseReviewStore(sb).orderPaymentFacts("WALLET-2", null)).toMatchObject({ ownPaymentCompleted: true, otherPaymentCompleted: false })
  })

  it("a completed row whose money already went back by hand is not 'another payment'", async () => {
    const hand = { reference: "b".repeat(32), internal_reference: "WALLET-1", status: "refunded_manually", amount_pesewas: 1, created_at: "2026-11-05T00:00:00Z" }
    const sb = fakeSb({ wallet_payments: [OWN, OTHER], shop_orders: [ORDER], hubtel_payments: [hand] })
    expect(await supabaseReviewStore(sb).orderPaymentFacts("WALLET-2", null)).toMatchObject({ otherPaymentCompleted: false })
    const stillHeld = { ...hand, reference: "c".repeat(32), status: "paid" }
    const sb2 = fakeSb({ wallet_payments: [OWN, OTHER], shop_orders: [ORDER], hubtel_payments: [hand, stillHeld] })
    expect(await supabaseReviewStore(sb2).orderPaymentFacts("WALLET-2", null)).toMatchObject({ otherPaymentCompleted: true })
  })

  it("only a completed refund on this order counts", async () => {
    const refund = (status: string, order_id = "o1", order_table = "shop_orders") => ({ order_id, order_table, status })
    for (const [rows, want] of [
      [[refund("completed")], true], [[refund("failed")], false], [[refund("processing")], false],
      [[refund("completed", "o2")], false], [[refund("completed", "o1", "ussd_orders")], false],
    ] as [Record<string, unknown>[], boolean][]) {
      const sb = fakeSb({ wallet_payments: [OWN], shop_orders: [ORDER], order_refunds: rows })
      expect((await supabaseReviewStore(sb).orderPaymentFacts("WALLET-2", null))?.refundCompleted).toBe(want)
    }
  })

  it.each([
    ["no wallet row", { wallet_payments: [] }, null],
    ["a wallet row with no order (top-up)", { wallet_payments: [{ ...OWN, order_id: null }] }, null],
    ["an order row that doesn't exist", { wallet_payments: [OWN], shop_orders: [] }, null],
    ["dealer upgrade", { wallet_payments: [{ ...OWN, order_type: "dealer_upgrade" }] }, null],
    ["airtime", { wallet_payments: [{ ...OWN, order_type: "airtime" }] }, null],
    ["results checker", { wallet_payments: [{ ...OWN, order_type: "results_checker" }] }, null],
    ["results check service", { wallet_payments: [{ ...OWN, order_type: "results_check_service" }] }, null],
    ["shop activation", { wallet_payments: [{ ...OWN, order_type: "ussd_shop_activation" }] }, null],
    ["shop token", { wallet_payments: [{ ...OWN, order_type: "ussd_shop_token" }] }, null],
    ["storefront bill", { wallet_payments: [{ ...OWN, order_type: "cs_bill" }] }, null],
    ["storefront bundle", { wallet_payments: [{ ...OWN, order_type: "cs_bundle" }] }, null],
    ["dealer upgrade by metadata", { wallet_payments: [OWN] }, { type: "dealer_upgrade" }],
    ["airtime by metadata", { wallet_payments: [OWN] }, { orderType: "airtime" }],
  ] as [string, Tables, unknown][])("no shop order facts for %s", async (_n, tables, metadata) => {
    const sb = fakeSb({ shop_orders: [ORDER], ...tables })
    expect(await supabaseReviewStore(sb).orderPaymentFacts("WALLET-2", metadata)).toBeNull()
  })

  it.each(["wallet_payments", "shop_orders", "order_refunds", "hubtel_payments"])("a failed read of %s throws: never guess", async (table) => {
    const sb = fakeSb({ wallet_payments: [OWN, OTHER], shop_orders: [ORDER] }, { [table]: "boom" })
    await expect(supabaseReviewStore(sb).orderPaymentFacts("WALLET-2", null)).rejects.toThrow()
  })
})

// Asked before the form opens, so an admin never pays a customer back and only then learns the payment doesn't qualify.
describe("checkManualRefund", () => {
  const second = { order: orderFacts() }
  it("says yes for a second payment, and writes nothing", async () => {
    const { deps, updates } = setup(baseRow(), paid(), second)
    expect(await checkManualRefund(deps, REF, "a")).toMatchObject({ ok: true, check: { kind: "paid" } })
    expect(updates).toHaveLength(0)
  })
  it("refuses an order's only payment, and writes nothing", async () => {
    const { deps, updates } = setup(baseRow(), paid(), { order: orderFacts({ ownPaymentCompleted: true, otherPaymentCompleted: false }) })
    const out = await checkManualRefund(deps, REF, "a")
    expect(out).toMatchObject({ ok: false, status: 409 })
    expect(out.message).toMatch(/only payment/)
    expect(updates).toHaveLength(0)
  })
  it("refuses when Hubtel doesn't say Paid, or can't be asked", async () => {
    const { deps } = setup(baseRow(), paid({ kind: "unpaid" }), second)
    expect(await checkManualRefund(deps, REF, "a")).toMatchObject({ ok: false, status: 409 })
    const failing = setup(baseRow(), paid({ kind: "error" }), second)
    expect(await checkManualRefund(failing.deps, REF, "a")).toMatchObject({ ok: false, status: 502 })
  })
  it("refuses a row that isn't waiting for review", async () => {
    const { deps } = setup(baseRow({ status: "paid" }), paid(), second)
    expect(await checkManualRefund(deps, REF, "a")).toMatchObject({ ok: false, status: 409 })
  })
  it("gives the same answer the record step does", async () => {
    const { deps } = setup(baseRow(), paid(), second)
    expect((await checkManualRefund(deps, REF, "a")).ok).toBe(true)
    expect((await markRefundedManually(deps, REF, "a", { adminReference: "MM12345", note: "paid back" })).ok).toBe(true)
  })
})

describe("recheck and list", () => {
  it("recheck shows the result and writes nothing", async () => {
    const { deps, updates } = setup(baseRow())
    expect(await recheckPayment(deps, REF, "a")).toMatchObject({ ok: true, check: { kind: "paid", amountGhs: 1.01, chargesGhs: 0.01 } })
    expect(updates).toHaveLength(0)
  })
  it("list gives reference, internal reference, amount, reason and age; no phone", async () => {
    const { deps } = setup(baseRow({ last_check: { status: "Paid", data: { amount: 0.5, paymentMethod: "mobilemoney" } } }))
    const [item] = await listReview(deps)
    expect(item).toMatchObject({ reference: REF, internalReference: "WALLET-1", amountGhs: 1, ageMinutes: 60 })
    expect(item.reason).toMatch(/less than/)
    expect(Object.keys(item)).not.toContain("msisdn")
  })
  it("reasons for other cases", () => {
    expect(reasonOf({ status: "confirming", last_check: null, amount_pesewas: 1 })).toMatch(/stale/)
    expect(reasonOf({ status: "needs_review", last_check: { upstreamStatus: 404 }, amount_pesewas: 1 })).toMatch(/no record/)
    expect(reasonOf({ status: "needs_review", last_check: { status: "Paid", data: { amount: 1, paymentMethod: "card" } }, amount_pesewas: 100 })).toMatch(/not mobile money/)
  })
})
