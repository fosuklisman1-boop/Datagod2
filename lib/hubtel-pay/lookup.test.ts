import { describe, expect, it, vi } from "vitest"
import {
  confirmAndReadHubtelPayment, findHubtelPaymentByInternalRef, findHubtelPayments, hubtelReportStatus, isLiveHubtelStatus,
  isHubtelWalletPayment, isManuallyRefundedPayment,
} from "./lookup"

type Row = Record<string, any>
const ref = (n: number) => n.toString(16).padStart(32, "0")

/** Applies eq/in filters to an in-memory hubtel_payments table; records every call. */
function fakeDb(rows: Row[], opts: { error?: { code?: string; message: string } } = {}) {
  const calls: string[] = []
  const db: any = {
    from(table: string) {
      calls.push(`from:${table}`)
      const filters: ((r: Row) => boolean)[] = []
      const q: any = {
        select: (c: string) => (calls.push(`select:${c}`), q),
        order: () => q,
        eq: (c: string, v: unknown) => (calls.push(`eq:${c}`), filters.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (calls.push(`in:${c}:${vs.length}`), filters.push((r) => vs.includes(r[c])), q),
        maybeSingle: async () => (opts.error ? { data: null, error: opts.error } : { data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
        then: (ok: any, ko: any) => Promise.resolve(opts.error
          ? { data: null, error: opts.error }
          : { data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(ok, ko),
      }
      return q
    },
  }
  return { db, calls }
}

const row = (o: Row): Row => ({ reference: ref(1), internal_reference: "WALLET-1", status: "pending", amount_pesewas: 1000, created_at: "2026-11-04T10:00:00Z", ...o })

describe("findHubtelPayments", () => {
  it("makes no query for an empty list", async () => {
    const { db, calls } = fakeDb([])
    expect((await findHubtelPayments(db, [])).size).toBe(0)
    expect((await findHubtelPayments(db, [null, undefined, ""])).size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it("one query for many references; keyed by internal_reference", async () => {
    const { db, calls } = fakeDb([row({ internal_reference: "A" }), row({ reference: ref(2), internal_reference: "B", status: "paid" })])
    const m = await findHubtelPayments(db, ["A", "B", "C", "A"])
    expect(calls.filter((c) => c.startsWith("from:"))).toEqual(["from:hubtel_payments"])
    expect(calls).toContain("in:internal_reference:3")
    expect(m.get("A")?.reference).toBe(ref(1))
    expect(m.get("B")?.status).toBe("paid")
    expect(m.has("C")).toBe(false)
  })

  it("prefers paid > needs_review > open > failed, then the newest", async () => {
    const { db } = fakeDb([
      row({ reference: ref(1), status: "failed", created_at: "2026-11-04T12:00:00Z" }),
      row({ reference: ref(2), status: "pending", created_at: "2026-11-04T11:00:00Z" }),
      row({ reference: ref(3), status: "needs_review", created_at: "2026-11-04T09:00:00Z" }),
    ])
    expect((await findHubtelPayments(db, ["WALLET-1"])).get("WALLET-1")?.reference).toBe(ref(3))
    const { db: db2 } = fakeDb([
      row({ reference: ref(1), status: "failed", created_at: "2026-11-04T09:00:00Z" }),
      row({ reference: ref(2), status: "failed", created_at: "2026-11-04T12:00:00Z" }),
    ])
    expect((await findHubtelPayments(db2, ["WALLET-1"])).get("WALLET-1")?.reference).toBe(ref(2))
  })

  it("a refunded_manually attempt ranks below every other status: it never speaks for a payment that has another attempt", async () => {
    for (const other of ["failed", "pending", "needs_review", "paid"]) {
      const { db } = fakeDb([
        row({ reference: ref(1), status: other, created_at: "2026-11-04T09:00:00Z" }),
        row({ reference: ref(2), status: "refunded_manually", created_at: "2026-11-04T12:00:00Z" }),
      ])
      expect((await findHubtelPayments(db, ["WALLET-1"])).get("WALLET-1")?.reference).toBe(ref(1))
    }
  })

  it("chunks very long lists", async () => {
    const { db, calls } = fakeDb([])
    await findHubtelPayments(db, Array.from({ length: 450 }, (_, i) => `R${i}`))
    expect(calls.filter((c) => c.startsWith("in:"))).toEqual(["in:internal_reference:200", "in:internal_reference:200", "in:internal_reference:50"])
  })

  it("a missing table (migration not applied) means no Hubtel payments", async () => {
    for (const code of ["42P01", "PGRST205"]) {
      const { db } = fakeDb([], { error: { code, message: "relation does not exist" } })
      expect((await findHubtelPayments(db, ["A"])).size).toBe(0)
    }
  })

  it("any other database error throws (callers must not guess)", async () => {
    const { db } = fakeDb([], { error: { code: "57014", message: "timeout" } })
    await expect(findHubtelPayments(db, ["A"])).rejects.toThrow(/hubtel_payments lookup failed/)
  })

  it("findHubtelPaymentByInternalRef returns one row or null", async () => {
    const { db } = fakeDb([row({})])
    expect((await findHubtelPaymentByInternalRef(db, "WALLET-1"))?.reference).toBe(ref(1))
    expect(await findHubtelPaymentByInternalRef(db, "nope")).toBeNull()
  })
})

describe("status helpers", () => {
  it("live = pending, confirming, paid, needs_review", () => {
    expect(["pending", "confirming", "paid", "needs_review"].every(isLiveHubtelStatus)).toBe(true)
    expect(isLiveHubtelStatus("failed")).toBe(false)
    expect(isLiveHubtelStatus("refunded_manually")).toBe(false)
    expect(isLiveHubtelStatus(undefined)).toBe(false)
  })
  it("report status", () => {
    expect(hubtelReportStatus("paid")).toBe("success")
    expect(hubtelReportStatus("failed")).toBe("failed")
    expect(hubtelReportStatus("refunded_manually")).toBe("failed")
    expect(hubtelReportStatus("needs_review")).toBe("needs_review")
    expect(hubtelReportStatus("pending")).toBe("pending")
    expect(hubtelReportStatus("confirming")).toBe("pending")
  })
  it("isHubtelWalletPayment: payment_method hubtel, or a live Hubtel row", () => {
    expect(isHubtelWalletPayment({ payment_method: "hubtel" }, null)).toBe(true)
    expect(isHubtelWalletPayment({ payment_method: "paystack" }, row({ status: "paid" }) as any)).toBe(true)
    expect(isHubtelWalletPayment({ payment_method: "paystack" }, row({ status: "failed" }) as any)).toBe(false)
    expect(isHubtelWalletPayment({ payment_method: null }, null)).toBe(false)
    expect(isHubtelWalletPayment({}, undefined)).toBe(false)
  })
  it("a refunded_manually attempt is not what makes a wallet row Hubtel's: the row is closed", () => {
    expect(isHubtelWalletPayment({ payment_method: "paystack" }, row({ status: "refunded_manually" }) as any)).toBe(false)
  })
  it("a payment went back by hand when an attempt says so and no other attempt holds money", () => {
    expect(isManuallyRefundedPayment([{ status: "refunded_manually" }])).toBe(true)
    expect(isManuallyRefundedPayment([{ status: "refunded_manually" }, { status: "failed" }])).toBe(true)
    expect(isManuallyRefundedPayment([{ status: "refunded_manually" }, { status: "paid" }])).toBe(false)
    expect(isManuallyRefundedPayment([{ status: "refunded_manually" }, { status: "needs_review" }])).toBe(false)
    expect(isManuallyRefundedPayment([{ status: "paid" }])).toBe(false)
    expect(isManuallyRefundedPayment([])).toBe(false)
  })
})

describe("confirmAndReadHubtelPayment", () => {
  it("confirms by the opaque reference and reports the row's resulting status", async () => {
    const { db } = fakeDb([row({ status: "paid" })])
    const confirm = vi.fn(async () => "fulfilled" as const)
    const r = await confirmAndReadHubtelPayment(db, row({ status: "pending" }) as any, confirm)
    expect(confirm).toHaveBeenCalledWith(ref(1))
    expect(r).toEqual({ reference: ref(1), outcome: "fulfilled", status: "paid", amount_pesewas: 1000 })
  })

  it("a throwing confirm is check_error and keeps the last known status", async () => {
    const { db } = fakeDb([row({ status: "pending" })])
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await confirmAndReadHubtelPayment(db, row({}) as any, vi.fn(async () => { throw new Error("relay down") }))
    expect(r.outcome).toBe("check_error")
    expect(r.status).toBe("pending")
  })

  it("an unreadable row after confirm keeps the status it had", async () => {
    const { db } = fakeDb([], { error: { message: "boom" } })
    const r = await confirmAndReadHubtelPayment(db, row({ status: "confirming" }) as any, vi.fn(async () => "pending" as const))
    expect(r.status).toBe("confirming")
  })
})
