import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { confirmHubtelPayment, isAllowedPaymentMethod, LIVE_SIBLING_STATUSES, ROW_COLUMNS, type ConfirmDeps, type HubtelPaymentRow, type HubtelPaymentStore, type RowPatch, type UpdateGuard } from "./confirm"
import type { PaymentStatus } from "./client"

const REF = "0123456789abcdef0123456789abcdef"
const T0 = new Date("2026-11-04T10:00:00.000Z")
const min = (n: number) => n * 60_000
/** "2026-11-04T10:00:00.000Z" → "2026-11-04T10:00:00.000456+00:00" (µs + offset, as PostgREST returns it). */
const pgStamp = (d: Date) => `${d.toISOString().slice(0, 23)}456+00:00`

interface Write { reference: string; patch: RowPatch; guard: UpdateGuard; applied: boolean }

/**
 * In-memory store whose claim is genuinely conditional and atomic (check-and-set in one synchronous step, like the
 * single UPDATE in claim_hubtel_payment), using the same clock as the code under test.
 */
function fakeStore(row: Partial<HubtelPaymentRow> | null, clock: () => Date) {
  const rows = new Map<string, HubtelPaymentRow>()
  if (row) {
    rows.set(REF, {
      reference: REF, amount_pesewas: 2000, status: "pending", claimed_at: null, claim_count: 0,
      created_at: new Date(T0.getTime() - min(1)).toISOString(),
      expires_at: new Date(T0.getTime() + min(30)).toISOString(), ...row,
    } as HubtelPaymentRow)
  }
  const writes: Write[] = []
  const claims: { reference: string; won: boolean }[] = []
  const siblingChecks: { internalReference: string; exceptReference: string }[] = []
  const paidSiblingChecks: { internalReference: string; exceptReference: string }[] = []
  const store: HubtelPaymentStore = {
    async load(ref) { const r = rows.get(ref); return r ? { ...r } : null },
    async claim(ref) {
      const r = rows.get(ref)
      const now = clock()
      const stale = r?.status === "confirming" && r.claimed_at !== null && new Date(r.claimed_at).getTime() < now.getTime() - min(10)
      if (!r || !(r.status === "pending" || stale)) { claims.push({ reference: ref, won: false }); return null }
      r.status = "confirming"
      // PostgREST returns timestamptz at microsecond precision with an offset.
      r.claimed_at = pgStamp(now)
      r.claim_count = (r.claim_count ?? 0) + 1
      ;(r as any).updated_at = now.toISOString()
      claims.push({ reference: ref, won: true })
      return { ...r }
    },
    async hasLiveSibling(internalReference, exceptReference) {
      siblingChecks.push({ internalReference, exceptReference })
      return [...rows.values()].some((r) => r.reference !== exceptReference && r.internal_reference === internalReference &&
        ["paid", "needs_review", "pending", "confirming"].includes(r.status))
    },
    async hasPaidSibling(internalReference, exceptReference) {
      paidSiblingChecks.push({ internalReference, exceptReference })
      return [...rows.values()].some((r) => r.reference !== exceptReference && r.internal_reference === internalReference && r.status === "paid")
    },
    async update(ref, patch, guard) {
      const r = rows.get(ref)
      const ok = !!r && guard.status.includes(r.status) && (guard.claimedAt === undefined || r.claimed_at === guard.claimedAt)
      writes.push({ reference: ref, patch, guard, applied: ok })
      if (ok) Object.assign(r!, patch)
      return ok
    },
  }
  return { store, rows, writes, claims, siblingChecks, paidSiblingChecks, get: () => rows.get(REF)! }
}

const paid = (over: Partial<PaymentStatus> = {}): PaymentStatus => ({
  kind: "paid", amountPesewas: 2000, chargesPesewas: 20, paymentMethod: "mobilemoney", transactionId: "tx-1", raw: { status: "Paid" }, ...over,
})

function setup(opts: {
  row?: Partial<HubtelPaymentRow> | null
  status?: PaymentStatus | (() => Promise<PaymentStatus>)
  success?: () => Promise<Response | null>
  failed?: () => Promise<Response | null>
  now?: Date
} = {}) {
  let now = opts.now ?? T0
  const clock = () => now
  const s = fakeStore(opts.row === undefined ? {} : opts.row, clock)
  const st = opts.status ?? paid()
  const checkStatus = vi.fn(typeof st === "function" ? st : async () => st)
  const onChargeSuccess = vi.fn(opts.success ?? (async () => null))
  const onChargeFailed = vi.fn(opts.failed ?? (async () => null))
  const notify = vi.fn(async () => {})
  const deps: ConfirmDeps = { store: s.store, checkStatus, onChargeSuccess, onChargeFailed, notify, now: clock }
  return { ...s, deps, checkStatus, onChargeSuccess, onChargeFailed, notify, setNow: (d: Date) => { now = d } }
}

const expectEveryWriteStampsUpdatedAt = (writes: Write[], at: Date = T0) => {
  for (const w of writes) expect(w.patch.updated_at).toBe(at.toISOString())
}

describe("confirmHubtelPayment — row lookup", () => {
  it("no row → ignored, no status check", async () => {
    const t = setup({ row: null })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("ignored")
    expect(t.checkStatus).not.toHaveBeenCalled()
  })
  it("malformed reference → ignored without touching the store", async () => {
    const t = setup()
    const load = vi.spyOn(t.store, "load")
    expect(await confirmHubtelPayment("WALLET-1", t.deps)).toBe("ignored")
    expect(load).not.toHaveBeenCalled()
  })
  it.each(["paid", "needs_review"] as const)("final status %s → ignored, no status check", async (status) => {
    const t = setup({ row: { status } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("ignored")
    expect(t.checkStatus).not.toHaveBeenCalled()
  })
  it("confirming claimed 9 min ago → ignored (not reclaimed)", async () => {
    const t = setup({ row: { status: "confirming", claimed_at: new Date(T0.getTime() - min(9)).toISOString() } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("ignored")
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
  })
  it("confirming claimed 11 min ago → reclaimed and fulfilled", async () => {
    const t = setup({ row: { status: "confirming", claimed_at: new Date(T0.getTime() - min(11)).toISOString() } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
    expect(t.onChargeSuccess).toHaveBeenCalledTimes(1)
    expect(t.get().status).toBe("paid")
  })
})

describe("confirmHubtelPayment — paid", () => {
  it("overpaid (Hubtel 2050 vs ours 2000) → claim, handler with OUR pesewas, then paid; Hubtel's figures stay on the row", async () => {
    const raw = { status: "Paid", amount: 20.5, charges: 0.2 }
    const t = setup({ status: paid({ amountPesewas: 2050, raw }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
    expect(t.onChargeSuccess).toHaveBeenCalledTimes(1)
    expect(t.onChargeSuccess).toHaveBeenCalledWith({ reference: REF, amount: 2000, id: "tx-1", gateway_response: "Hubtel: Paid" })
    expect(t.claims).toEqual([{ reference: REF, won: true }])
    const r = t.get()
    expect(r.status).toBe("paid")
    expect(r.hubtel_transaction_id).toBe("tx-1")
    expect(r.charges_pesewas).toBe(20)
    expect(r.payment_method).toBe("mobilemoney")
    expect(r.last_check).toEqual(raw)
    expectEveryWriteStampsUpdatedAt(t.writes)
    // the final write is guarded on OUR claim, using the exact µs string the claim returned (never re-formatted)
    const last = t.writes.at(-1)!
    expect(last.guard).toEqual({ status: ["confirming"], claimedAt: "2026-11-04T10:00:00.000456+00:00" })
    expect(last.guard.claimedAt).toBe(t.get().claimed_at)
  })

  it("needs_review write after a claim is guarded on the exact µs claimed_at string", async () => {
    const t = setup({ status: paid({ amountPesewas: 1 }) })
    await confirmHubtelPayment(REF, t.deps)
    expect(t.writes.at(-1)!.guard.claimedAt).toBe("2026-11-04T10:00:00.000456+00:00")
    expect(t.writes.at(-1)!.applied).toBe(true)
  })

  it("handler returns a 2xx NextResponse-like → paid", async () => {
    const t = setup({ success: async () => new Response("ok", { status: 200 }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
    expect(t.get().status).toBe("paid")
  })

  it("two concurrent confirms on a Paid row → handler called exactly once", async () => {
    // Both callers load the row and finish the status check before either claims.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let calls = 0
    const t = setup({ status: async () => { calls++; if (calls === 2) release(); await gate; return paid() } })
    const [a, b] = await Promise.all([confirmHubtelPayment(REF, t.deps), confirmHubtelPayment(REF, t.deps)])
    expect([a, b].sort()).toEqual(["fulfilled", "ignored"])
    expect(t.checkStatus).toHaveBeenCalledTimes(2)
    expect(t.onChargeSuccess).toHaveBeenCalledTimes(1)
    expect(t.claims.filter((c) => c.won)).toHaveLength(1)
    expect(t.get().status).toBe("paid")
  })

  it("amount 1999 vs expected 2000 → needs_review, alert, no handler", async () => {
    const t = setup({ status: paid({ amountPesewas: 1999 }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
    expect(t.claims).toEqual([{ reference: REF, won: true }])
    expect(t.get().status).toBe("needs_review")
    expect(t.notify).toHaveBeenCalledTimes(1)
    expectEveryWriteStampsUpdatedAt(t.writes)
  })

  it("pesewa comparison is exact (no float error): 19.99 GHS converted upstream = 1999 < 2000", async () => {
    const t = setup({ row: { amount_pesewas: 1999 }, status: paid({ amountPesewas: Math.round(19.99 * 100) }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
    expect(t.onChargeSuccess).toHaveBeenCalledWith(expect.objectContaining({ amount: 1999 }))
  })

  it("non-integer paid amount → needs_review (fail closed)", async () => {
    const t = setup({ status: paid({ amountPesewas: 2000.5 }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
  })

  it.each(["card", "CARD", "bankcard", "Visa Card", undefined, "", "ghqr", "cash"])("payment method %s → needs_review, alert, no handler", async (m) => {
    const t = setup({ status: paid({ paymentMethod: m }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
    expect(t.get().status).toBe("needs_review")
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it("two concurrent confirms on a short-paid row → one alert, one write", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let calls = 0
    const t = setup({ status: async () => { calls++; if (calls === 2) release(); await gate; return paid({ amountPesewas: 1500 }) } })
    const res = await Promise.all([confirmHubtelPayment(REF, t.deps), confirmHubtelPayment(REF, t.deps)])
    expect(res.sort()).toEqual(["ignored", "needs_review"])
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.writes.filter((w) => w.patch.status === "needs_review")).toHaveLength(1)
  })

  it.each([400, 404, 500])("handler responds %i → needs_review + alert, never paid", async (code) => {
    const t = setup({ success: async () => new Response("x", { status: code }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.get().status).toBe("needs_review")
    expect(t.notify).toHaveBeenCalledTimes(1)
    expectEveryWriteStampsUpdatedAt(t.writes)
  })

  it("handler throws → row stays confirming, admins alerted", async () => {
    const t = setup({ success: async () => { throw new Error("db down") } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("pending")
    expect(t.get().status).toBe("confirming")
    expect(t.writes).toHaveLength(0)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it("a throwing notify never changes the outcome", async () => {
    const t = setup({ status: paid({ amountPesewas: 1 }) })
    t.notify.mockRejectedValue(new Error("sms down"))
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
  })

  it("paid-write lost after handler ran → still fulfilled, admins alerted", async () => {
    const t = setup()
    const orig = t.store.update
    t.store.update = async () => false
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
    expect(t.onChargeSuccess).toHaveBeenCalledTimes(1)
    expect(t.notify).toHaveBeenCalledTimes(1)
    t.store.update = orig
  })

  it("alert messages carry no msisdn/raw payload (PII-free)", async () => {
    const t = setup({ row: { msisdn: "233241234567" } as any, status: paid({ amountPesewas: 1999, raw: { customerPhoneNumber: "233241234567" } }) })
    await confirmHubtelPayment(REF, t.deps)
    const [msg, type, ref] = t.notify.mock.calls[0] as unknown as [string, string, string]
    expect(msg).not.toContain("233241234567")
    expect(type).toBeTypeOf("string")
    expect(ref).toBe(REF)
  })
})

describe("confirmHubtelPayment — attempt cap (claim_count)", () => {
  const stale = (claim_count: number) => ({
    status: "confirming" as const, claim_count, claimed_at: new Date(T0.getTime() - min(11)).toISOString(),
  })

  it("1st claim (claim_count becomes 1) → handler called", async () => {
    const t = setup()
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
    expect(t.get().claim_count).toBe(1)
    expect(t.onChargeSuccess).toHaveBeenCalledTimes(1)
  })

  it("2nd claim (claim_count becomes 2) → handler called again", async () => {
    const t = setup({ row: stale(1) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
    expect(t.get().claim_count).toBe(2)
    expect(t.onChargeSuccess).toHaveBeenCalledTimes(1)
  })

  it("3rd claim (claim_count becomes 3) → no handler, needs_review, one 'stuck after 3 attempts' alert", async () => {
    const t = setup({ row: stale(2) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.get().claim_count).toBe(3)
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
    expect(t.get().status).toBe("needs_review")
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect((t.notify.mock.calls[0] as unknown as [string])[0]).toContain("stuck after 3 attempts")
    expectEveryWriteStampsUpdatedAt(t.writes)
  })

  it("claim_count beyond 3 → still capped", async () => {
    const t = setup({ row: stale(7) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
  })

  it("failure path is capped too: refunded on the 3rd claim → no handleChargeFailed, needs_review, one alert", async () => {
    const t = setup({ row: stale(2), status: { kind: "refunded", raw: {} } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.onChargeFailed).not.toHaveBeenCalled()
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it("a handler that throws every time is called at most twice before review", async () => {
    const t = setup({ success: async () => { throw new Error("always") } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("pending")
    t.setNow(new Date(T0.getTime() + min(11)))
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("pending")
    t.setNow(new Date(T0.getTime() + min(22)))
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.onChargeSuccess).toHaveBeenCalledTimes(2)
    expect(t.get().status).toBe("needs_review")
  })

  it("cap reached but the needs_review write did not land → no alert, says so in the log, no handler", async () => {
    const t = setup({ row: stale(2) })
    t.store.update = async () => false
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("check_error")
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
    expect(err.mock.calls.flat().join(" ")).toMatch(/could not write needs_review/)
    err.mockRestore()
  })

  it("cap reached and the write throws → same: no alert, logged, nothing thrown", async () => {
    const t = setup({ row: stale(2) })
    t.store.update = async () => { throw new Error("db down") }
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("check_error")
    expect(t.notify).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe("confirmHubtelPayment — internal reference and metadata", () => {
  const INTERNAL = "WALLET-1730000000-abc"
  const META = { type: "sms_bundle", sms_account_id: "acc-1" }

  it("handleChargeSuccess gets internal_reference and metadata; claim and row writes keep the opaque reference", async () => {
    const t = setup({ row: { internal_reference: INTERNAL, metadata: META } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
    expect(t.onChargeSuccess).toHaveBeenCalledWith(expect.objectContaining({ reference: INTERNAL, metadata: META, amount: 2000 }))
    expect(t.claims).toEqual([{ reference: REF, won: true }])
    expect(t.writes.length).toBeGreaterThan(0)
    for (const w of t.writes) expect(w.reference).toBe(REF)
    expect(t.get().status).toBe("paid")
  })

  it("handleChargeFailed gets them too (refunded and expired-unpaid)", async () => {
    const t = setup({ row: { internal_reference: INTERNAL, metadata: META }, status: { kind: "refunded", raw: {} } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("failed")
    expect(t.onChargeFailed).toHaveBeenCalledWith(expect.objectContaining({ reference: INTERNAL, metadata: META }))
    for (const w of t.writes) expect(w.reference).toBe(REF)

    const u = setup({ row: { internal_reference: INTERNAL, metadata: META }, status: { kind: "unpaid", raw: {} }, now: new Date(T0.getTime() + min(31)) })
    expect(await confirmHubtelPayment(REF, u.deps)).toBe("failed")
    expect(u.onChargeFailed).toHaveBeenCalledWith(expect.objectContaining({ reference: INTERNAL, metadata: META }))
  })

  describe("handler amount (merchant bears the fee)", () => {
    const row = { amount_pesewas: 1960, handler_amount_pesewas: 2000, internal_reference: INTERNAL }

    it("Hubtel paid the lowered amount → the handler gets the full price, the row keeps the requested amount", async () => {
      const t = setup({ row, status: paid({ amountPesewas: 1960 }) })
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
      expect(t.onChargeSuccess).toHaveBeenCalledWith(expect.objectContaining({ amount: 2000, reference: INTERNAL }))
      expect(t.get().amount_pesewas).toBe(1960)
    })

    it("the underpayment check still uses the requested amount: under it → needs_review, no handler", async () => {
      const t = setup({ row, status: paid({ amountPesewas: 1959 }) })
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
      expect(t.onChargeSuccess).not.toHaveBeenCalled()
    })

    it("no handler amount → amount_pesewas, as before", async () => {
      const t = setup({ row: { amount_pesewas: 2000, handler_amount_pesewas: null } })
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
      expect(t.onChargeSuccess).toHaveBeenCalledWith(expect.objectContaining({ amount: 2000 }))
    })
  })

  describe("sibling attempts for the same order", () => {
    const expiredAt = new Date(T0.getTime() + min(31))
    const addSibling = (t: ReturnType<typeof setup>, status: HubtelPaymentRow["status"], internal: string | null = INTERNAL) => {
      const sibling = "f".repeat(32)
      t.rows.set(sibling, { ...t.get(), reference: sibling, status, internal_reference: internal })
    }
    const expiredUnpaid = () => setup({ row: { internal_reference: INTERNAL }, status: { kind: "unpaid", raw: {} }, now: expiredAt })

    it.each(["paid", "needs_review", "pending", "confirming"] as const)("expired attempt with a %s sibling → no handleChargeFailed, row closed failed", async (siblingStatus) => {
      const t = expiredUnpaid()
      addSibling(t, siblingStatus)
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("failed")
      expect(t.onChargeFailed).not.toHaveBeenCalled()
      expect(t.get().status).toBe("failed")
      expect(t.siblingChecks).toEqual([{ internalReference: INTERNAL, exceptReference: REF }])
    })

    it("the real sibling query covers exactly these statuses", () => {
      expect([...LIVE_SIBLING_STATUSES].sort()).toEqual(["confirming", "needs_review", "paid", "pending"])
    })

    it("expired attempt with only a failed sibling → handler runs", async () => {
      const t = expiredUnpaid()
      addSibling(t, "failed")
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("failed")
      expect(t.onChargeFailed).toHaveBeenCalledTimes(1)
    })

    it("a paid row for ANOTHER order changes nothing", async () => {
      const t = expiredUnpaid()
      addSibling(t, "paid", "another-order")
      await confirmHubtelPayment(REF, t.deps)
      expect(t.onChargeFailed).toHaveBeenCalledTimes(1)
    })

    it("refunded with a paid sibling → no failure handler, the refund alert still goes out", async () => {
      const t = setup({ row: { internal_reference: INTERNAL }, status: { kind: "refunded", amountPesewas: 2000, raw: {} } })
      addSibling(t, "paid")
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("failed")
      expect(t.onChargeFailed).not.toHaveBeenCalled()
      expect(t.notify).toHaveBeenCalledTimes(1)
    })

    it("no internal_reference → no sibling lookup, handler runs", async () => {
      const t = setup({ row: { internal_reference: null }, status: { kind: "unpaid", raw: {} }, now: expiredAt })
      await confirmHubtelPayment(REF, t.deps)
      expect(t.siblingChecks).toHaveLength(0)
      expect(t.onChargeFailed).toHaveBeenCalledTimes(1)
    })

    it("the sibling lookup failing → no handler, row left confirming for the sweep, alert, check_error", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      const t = expiredUnpaid()
      t.deps.store.hasLiveSibling = async () => { throw new Error("db down") }
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("check_error")
      expect(t.onChargeFailed).not.toHaveBeenCalled()
      expect(t.get().status).toBe("confirming")
      expect(t.notify).toHaveBeenCalledTimes(1)
      err.mockRestore()
    })

    it("paid with a paid sibling → needs_review, one alert, no handler: the customer may have paid twice", async () => {
      const t = setup({ row: { internal_reference: INTERNAL } })
      addSibling(t, "paid")
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
      expect(t.onChargeSuccess).not.toHaveBeenCalled()
      expect(t.get().status).toBe("needs_review")
      expect(t.get().hubtel_transaction_id).toBe("tx-1")
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect(t.paidSiblingChecks).toEqual([{ internalReference: INTERNAL, exceptReference: REF }])
    })

    it.each(["failed", "needs_review", "pending", "confirming"] as const)("paid with a %s sibling → fulfilled as normal", async (siblingStatus) => {
      const t = setup({ row: { internal_reference: INTERNAL } })
      addSibling(t, siblingStatus)
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
      expect(t.onChargeSuccess).toHaveBeenCalledTimes(1)
    })

    it("paid with no internal_reference → no sibling lookup", async () => {
      const t = setup({ row: { internal_reference: null } })
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
      expect(t.paidSiblingChecks).toHaveLength(0)
    })

    it("the paid-sibling lookup failing → no handler, left confirming, alert, check_error", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      const t = setup({ row: { internal_reference: INTERNAL } })
      t.deps.store.hasPaidSibling = async () => { throw new Error("db down") }
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("check_error")
      expect(t.onChargeSuccess).not.toHaveBeenCalled()
      expect(t.get().status).toBe("confirming")
      expect(t.notify).toHaveBeenCalledTimes(1)
      err.mockRestore()
    })
  })

  describe("handler reports the order was already closed", () => {
    const body = (b: unknown) => async () => Response.json(b)

    it("order_closed in a 2xx body → needs_review + alert, not paid", async () => {
      const t = setup({ success: body({ received: true, order_closed: true }) })
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
      expect(t.get().status).toBe("needs_review")
      expect(t.notify).toHaveBeenCalledTimes(1)
      expect((t.notify.mock.calls[0] as unknown as string[])[0]).toContain("Needs review")
    })

    it.each<[string, () => Promise<Response | null>]>([
      ["null", async () => null],
      ["{received:true}", body({ received: true })],
      ["order_closed false", body({ received: true, order_closed: false })],
      ["an empty body", async () => new Response(null, { status: 200 })],
      ["non-JSON", async () => new Response("ok", { status: 200 })],
      ["a JSON array", body([1])],
    ])("%s → fulfilled and paid", async (_n, success) => {
      const t = setup({ success })
      expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
      expect(t.get().status).toBe("paid")
    })
  })

  it("null columns fall back to the opaque reference and no metadata", async () => {
    const t = setup({ row: { internal_reference: null, metadata: null } })
    await confirmHubtelPayment(REF, t.deps)
    const data = (t.onChargeSuccess.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(data.reference).toBe(REF)
    expect(data.metadata).toBeUndefined()
  })

  it("the status check still uses the opaque reference", async () => {
    const t = setup({ row: { internal_reference: INTERNAL } })
    await confirmHubtelPayment(REF, t.deps)
    expect(t.checkStatus).toHaveBeenCalledWith(REF)
  })

  it("ROW_COLUMNS selects every column confirm reads, and each exists in migration 0151", () => {
    const sql = readFileSync(join(process.cwd(), "migrations/0151_hubtel_payments.sql"), "utf8")
    const cols = ROW_COLUMNS.split(",").map((c) => c.trim())
    expect(cols).toEqual(expect.arrayContaining(["amount_pesewas", "created_at", "internal_reference", "metadata", "handler_amount_pesewas", "refused_at"]))
    for (const c of cols) expect(sql).toMatch(new RegExp(`^\\s+${c}\\s`, "m"))
  })
})

describe("confirmHubtelPayment — late payment on a failed row", () => {
  const HOUR = min(60)
  const failedRow = (ageMs = HOUR) => ({ status: "failed" as const, created_at: new Date(T0.getTime() - ageMs).toISOString() })

  it("a refused row (refused_at set) is never status-checked: nothing reached Hubtel", async () => {
    const t = setup({ row: { ...failedRow(), refused_at: T0.toISOString() }, status: paid() })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("ignored")
    expect(t.checkStatus).not.toHaveBeenCalled()
    expect(t.writes).toHaveLength(0)
    expect(t.notify).not.toHaveBeenCalled()
  })

  it("Paid → guarded failed→needs_review, one PII-free alert, never a handler or a claim", async () => {
    const raw = { status: "Paid", customerPhoneNumber: "233241234567" }
    const t = setup({ row: { ...failedRow(), msisdn: "233241234567" } as any, status: paid({ raw }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.get().status).toBe("needs_review")
    expect(t.get().last_check).toEqual(raw)
    expect(t.get().hubtel_transaction_id).toBe("tx-1")
    expect(t.writes).toHaveLength(1)
    expect(t.writes[0].guard).toEqual({ status: ["failed"] })
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
    expect(t.onChargeFailed).not.toHaveBeenCalled()
    expect(t.claims).toHaveLength(0)
    expect(t.notify).toHaveBeenCalledTimes(1)
    const [message, type, reference] = t.notify.mock.calls[0] as unknown as [string, string, string]
    expect(message).toContain("charged after the payment was marked failed")
    expect(message).not.toContain("233241234567")
    expect(type).toBe("hubtel_payment")
    expect(reference).toBe(REF)
    expectEveryWriteStampsUpdatedAt(t.writes)
  })

  it("concurrent callers both see Paid → one write lands, one alert", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let calls = 0
    const t = setup({ row: failedRow(), status: async () => { calls++; if (calls === 2) release(); await gate; return paid() } })
    const out = await Promise.all([confirmHubtelPayment(REF, t.deps), confirmHubtelPayment(REF, t.deps)])
    expect([...out].sort()).toEqual(["ignored", "needs_review"])
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.writes.filter((w) => w.applied)).toHaveLength(1)
  })

  it.each([
    ["unpaid", { kind: "unpaid", raw: { status: "Unpaid" } }],
    ["refunded", { kind: "refunded", raw: { status: "Refunded" } }],
    ["not_found", { kind: "not_found", raw: {} }],
    ["error", { kind: "error", raw: {} }],
  ] as [string, PaymentStatus][])("%s → stamps updated_at only, stays failed, ignored, no alert", async (_k, status) => {
    const t = setup({ row: { ...failedRow(), last_check: { status: "Unpaid", original: true } }, status })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("ignored")
    expect(t.get().status).toBe("failed")
    expect(t.get().last_check).toEqual({ status: "Unpaid", original: true })
    expect(t.writes).toHaveLength(1)
    expect(t.writes[0].patch).toEqual({ updated_at: T0.toISOString() })
    expect(t.writes[0].guard).toEqual({ status: ["failed"] })
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.onChargeFailed).not.toHaveBeenCalled()
  })

  it("73h old → ignored, no status check, no write", async () => {
    const t = setup({ row: failedRow(73 * HOUR) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("ignored")
    expect(t.checkStatus).not.toHaveBeenCalled()
    expect(t.writes).toHaveLength(0)
  })

  it("exactly 72h old → ignored (the window is under 72h)", async () => {
    const t = setup({ row: failedRow(72 * HOUR) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("ignored")
    expect(t.checkStatus).not.toHaveBeenCalled()
  })

  it("71h old → checked", async () => {
    const t = setup({ row: failedRow(71 * HOUR) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.checkStatus).toHaveBeenCalledTimes(1)
  })
})

describe("confirmHubtelPayment — unpaid / refunded", () => {
  it("unpaid before expiry → last_check stored, stays pending, no claim, no handler", async () => {
    const t = setup({ status: { kind: "unpaid", raw: { status: "Unpaid" } } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("pending")
    expect(t.claims).toHaveLength(0)
    expect(t.onChargeFailed).not.toHaveBeenCalled()
    expect(t.get().status).toBe("pending")
    expect(t.get().last_check).toEqual({ status: "Unpaid" })
    expectEveryWriteStampsUpdatedAt(t.writes)
  })

  it("unpaid after expiry → claim, handleChargeFailed, failed", async () => {
    const after = new Date(T0.getTime() + min(31))
    const t = setup({ status: { kind: "unpaid", raw: { status: "Unpaid" } }, now: after })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("failed")
    expect(t.claims).toEqual([{ reference: REF, won: true }])
    expect(t.onChargeFailed).toHaveBeenCalledTimes(1)
    expect(t.onChargeFailed).toHaveBeenCalledWith(expect.objectContaining({ reference: REF, gateway_response: expect.stringContaining("Unpaid") }))
    expect(t.get().status).toBe("failed")
    expect(t.notify).not.toHaveBeenCalled()
    expectEveryWriteStampsUpdatedAt(t.writes, after)
  })

  it("unpaid exactly at expiry → failed (expiry is inclusive)", async () => {
    const t = setup({ status: { kind: "unpaid", raw: {} }, now: new Date(T0.getTime() + min(30)) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("failed")
  })

  it("refunded → claim, handleChargeFailed, failed, admins alerted", async () => {
    const t = setup({ status: { kind: "refunded", amountPesewas: 2000, raw: { status: "Refunded" } } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("failed")
    expect(t.onChargeFailed).toHaveBeenCalledTimes(1)
    expect(t.onChargeFailed).toHaveBeenCalledWith(expect.objectContaining({ reference: REF, gateway_response: expect.stringContaining("Refunded") }))
    expect(t.get().status).toBe("failed")
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it("failed handler throws → stays confirming, alert", async () => {
    const t = setup({ status: { kind: "refunded", raw: {} }, failed: async () => { throw new Error("x") } })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("pending")
    expect(t.get().status).toBe("confirming")
    expect(t.notify).toHaveBeenCalled()
  })

  it("failed handler responds non-2xx → needs_review + alert", async () => {
    const t = setup({ status: { kind: "unpaid", raw: {} }, now: new Date(T0.getTime() + min(60)), failed: async () => new Response("x", { status: 500 }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.get().status).toBe("needs_review")
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it("refunded but claim lost → ignored, no handler, no alert", async () => {
    const t = setup({ status: { kind: "refunded", raw: {} } })
    t.store.claim = async () => null
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("ignored")
    expect(t.onChargeFailed).not.toHaveBeenCalled()
    expect(t.notify).not.toHaveBeenCalled()
  })
})

describe("confirmHubtelPayment — not_found / error", () => {
  it.each([["not_found", "pending"], ["error", "check_error"]] as const)("%s → last_check stored, stays pending, never failed, outcome %s", async (kind, outcome) => {
    const t = setup({ status: { kind, raw: { upstreamStatus: 404 } }, now: new Date(T0.getTime() + min(600)) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe(outcome)
    expect(t.claims).toHaveLength(0)
    expect(t.onChargeFailed).not.toHaveBeenCalled()
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
    expect(t.get().status).toBe("pending")
    expect(t.get().last_check).toEqual({ upstreamStatus: 404 })
    expect(t.writes).toHaveLength(1)
    expectEveryWriteStampsUpdatedAt(t.writes, new Date(T0.getTime() + min(600)))
  })

  // setup()'s default row expires at T0 + 30 min.
  const EXPIRY = T0.getTime() + min(30)
  const afterExpiry = (ms: number) => new Date(EXPIRY + ms)
  const HOUR = min(60)

  it.each([
    ["not_found", 23 * HOUR, "pending"],
    ["error", 23 * HOUR, "check_error"],
    ["not_found", 24 * HOUR, "pending"],
  ] as const)("%s at expiry + %i ms → stays pending, no claim, no alert", async (kind, offset, outcome) => {
    const at = afterExpiry(offset)
    const t = setup({ status: { kind, raw: { upstreamStatus: 404 } }, now: at })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe(outcome)
    expect(t.claims).toHaveLength(0)
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.get().status).toBe("pending")
    expectEveryWriteStampsUpdatedAt(t.writes, at)
  })

  it("a kind-error check never parks a row, however long after expiry", async () => {
    const at = afterExpiry(100 * HOUR)
    const t = setup({ status: { kind: "error", raw: {} }, now: at })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("check_error")
    expect(t.claims).toHaveLength(0)
    expect(t.notify).not.toHaveBeenCalled()
    expect(t.get().status).toBe("pending")
  })

  it("not_found at expiry + 25h but the needs_review write did not land → no alert, logged, not reported as needs_review", async () => {
    const t = setup({ status: { kind: "not_found", raw: {} }, now: afterExpiry(25 * HOUR) })
    t.store.update = async () => false
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("check_error")
    expect(t.notify).not.toHaveBeenCalled()
    expect(err.mock.calls.flat().join(" ")).toMatch(/could not write needs_review/)
    err.mockRestore()
  })

  it.each(["not_found"] as const)("%s at expiry + 25h → claimed, needs_review, one PII-free alert, no handler", async (kind) => {
    const at = afterExpiry(25 * HOUR)
    const t = setup({ status: { kind, raw: { upstreamStatus: 404 } }, now: at })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.claims).toEqual([{ reference: REF, won: true }])
    expect(t.get().status).toBe("needs_review")
    expect(t.get().last_check).toEqual({ upstreamStatus: 404 })
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
    expect(t.onChargeFailed).not.toHaveBeenCalled()
    expect(t.notify).toHaveBeenCalledTimes(1)
    const [message, type, reference] = t.notify.mock.calls[0] as unknown as [string, string, string]
    expect(message).toContain("no Hubtel record 24h after expiry")
    expect(message).not.toMatch(/\b(233|0)\d{9}\b/)
    expect(type).toBe("hubtel_payment")
    expect(reference).toBe(REF)
    expectEveryWriteStampsUpdatedAt(t.writes, at)
  })

  it("a stale confirming row past expiry + 25h also goes to needs_review", async () => {
    const at = afterExpiry(25 * HOUR)
    const t = setup({
      row: { status: "confirming", claimed_at: new Date(at.getTime() - min(11)).toISOString(), claim_count: 1 },
      status: { kind: "not_found", raw: {} }, now: at,
    })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("needs_review")
    expect(t.get().status).toBe("needs_review")
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it("two concurrent callers at expiry + 25h → one claim wins, one alert", async () => {
    const t = setup({ status: { kind: "not_found", raw: {} }, now: afterExpiry(25 * HOUR) })
    const out = await Promise.all([confirmHubtelPayment(REF, t.deps), confirmHubtelPayment(REF, t.deps)])
    expect([...out].sort()).toEqual(["ignored", "needs_review"])
    expect(t.claims.filter((c) => c.won)).toHaveLength(1)
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.get().status).toBe("needs_review")
  })

  it("unpaid past expiry + 25h is still failed, not parked for review", async () => {
    const t = setup({ status: { kind: "unpaid", raw: {} }, now: afterExpiry(25 * HOUR) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("failed")
    expect(t.onChargeFailed).toHaveBeenCalledTimes(1)
  })
})

describe("isAllowedPaymentMethod", () => {
  it.each(["mobilemoney", "MobileMoney", "mobile money", "wallet", "hubtel", "gmoney", "G-Money"])("%s allowed", (m) => {
    expect(isAllowedPaymentMethod(m)).toBe(true)
  })
  it.each(["card", "Card", "bankcard", "mobilemoneycard", "ghqr", "cash", "", undefined])("%s refused", (m) => {
    expect(isAllowedPaymentMethod(m)).toBe(false)
  })
})
