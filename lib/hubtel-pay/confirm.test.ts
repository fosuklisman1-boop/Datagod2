import { describe, it, expect, vi } from "vitest"
import { confirmHubtelPayment, isAllowedPaymentMethod, type ConfirmDeps, type HubtelPaymentRow, type HubtelPaymentStore, type RowPatch, type UpdateGuard } from "./confirm"
import type { PaymentStatus } from "./client"

const REF = "0123456789abcdef0123456789abcdef"
const T0 = new Date("2026-11-04T10:00:00.000Z")
const min = (n: number) => n * 60_000

interface Write { reference: string; patch: RowPatch; guard: UpdateGuard; applied: boolean }

/**
 * In-memory store whose claim is genuinely conditional and atomic (check-and-set in one synchronous step, like the
 * single UPDATE in claim_hubtel_payment), using the same clock as the code under test.
 */
function fakeStore(row: Partial<HubtelPaymentRow> | null, clock: () => Date) {
  const rows = new Map<string, HubtelPaymentRow>()
  if (row) {
    rows.set(REF, {
      reference: REF, amount_pesewas: 2000, status: "pending", claimed_at: null,
      expires_at: new Date(T0.getTime() + min(30)).toISOString(), ...row,
    } as HubtelPaymentRow)
  }
  const writes: Write[] = []
  const claims: { reference: string; won: boolean }[] = []
  const store: HubtelPaymentStore = {
    async load(ref) { const r = rows.get(ref); return r ? { ...r } : null },
    async claim(ref) {
      const r = rows.get(ref)
      const now = clock()
      const stale = r?.status === "confirming" && r.claimed_at !== null && new Date(r.claimed_at).getTime() < now.getTime() - min(10)
      if (!r || !(r.status === "pending" || stale)) { claims.push({ reference: ref, won: false }); return null }
      r.status = "confirming"
      r.claimed_at = now.toISOString()
      ;(r as any).updated_at = now.toISOString()
      claims.push({ reference: ref, won: true })
      return { ...r }
    },
    async update(ref, patch, guard) {
      const r = rows.get(ref)
      const ok = !!r && guard.status.includes(r.status) && (guard.claimedAt === undefined || r.claimed_at === guard.claimedAt)
      writes.push({ reference: ref, patch, guard, applied: ok })
      if (ok) Object.assign(r!, patch)
      return ok
    },
  }
  return { store, rows, writes, claims, get: () => rows.get(REF)! }
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
  it.each(["paid", "failed", "needs_review"] as const)("final status %s → ignored, no status check", async (status) => {
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
  it("amount and method OK → claim, handler with Hubtel's pesewas, then paid with tx/charges/method", async () => {
    const t = setup({ status: paid({ amountPesewas: 2050 }) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("fulfilled")
    expect(t.onChargeSuccess).toHaveBeenCalledTimes(1)
    expect(t.onChargeSuccess).toHaveBeenCalledWith({ reference: REF, amount: 2050, id: "tx-1", gateway_response: "Hubtel: Paid" })
    expect(t.claims).toEqual([{ reference: REF, won: true }])
    const r = t.get()
    expect(r.status).toBe("paid")
    expect(r.hubtel_transaction_id).toBe("tx-1")
    expect(r.charges_pesewas).toBe(20)
    expect(r.payment_method).toBe("mobilemoney")
    expect(r.last_check).toEqual({ status: "Paid" })
    expectEveryWriteStampsUpdatedAt(t.writes)
    // the final write is guarded on OUR claim
    const last = t.writes.at(-1)!
    expect(last.guard).toEqual({ status: ["confirming"], claimedAt: T0.toISOString() })
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
  it.each(["not_found", "error"] as const)("%s → last_check stored, stays pending, never failed", async (kind) => {
    const t = setup({ status: { kind, raw: { upstreamStatus: 404 } }, now: new Date(T0.getTime() + min(600)) })
    expect(await confirmHubtelPayment(REF, t.deps)).toBe("pending")
    expect(t.claims).toHaveLength(0)
    expect(t.onChargeFailed).not.toHaveBeenCalled()
    expect(t.onChargeSuccess).not.toHaveBeenCalled()
    expect(t.get().status).toBe("pending")
    expect(t.get().last_check).toEqual({ upstreamStatus: 404 })
    expect(t.writes).toHaveLength(1)
    expectEveryWriteStampsUpdatedAt(t.writes, new Date(T0.getTime() + min(600)))
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
