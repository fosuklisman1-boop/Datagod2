import { describe, expect, it, vi } from "vitest"
import { fulfilPayment, fulfilRefusal, listReview, markPaymentFailed, reasonOf, recheckPayment, type ReviewDeps, type ReviewRow } from "./review"
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
function setup(row: ReviewRow | null, status: PaymentStatus = paid(), o: { paidSibling?: boolean; handler?: () => Promise<Response | null> } = {}) {
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
