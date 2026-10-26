import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))
const checkPhoneVerified = vi.hoisted(() => vi.fn())
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified }))

import { BILL_ORDER_V2_COLUMNS, fetchBillOrderByCode, payBillTracked, realBillsPhoneGate, surfaceOpenFrom } from "./bills-deps"
import type { BillOrderRow, BillsDeps } from "@/lib/bills/service"
import { resolveBillsConfig } from "@/lib/bills/config"
import { resolveCashbackConfig } from "@/lib/cashback/config"
import { signBillToken } from "@/lib/bills/token"

// Unique test data for this file: smartcards 8000000750-8000000759, phones 0249990750-0249990759.
const SMARTCARD = "8000000750"
const SECRET = "s".repeat(40)
const NOW = 1_800_000_000_000

function fakeClient(result: { data: unknown; error: unknown } | "throw") {
  const calls: Array<[string, ...unknown[]]> = []
  const q: any = {}
  const settle = () => (result === "throw" ? Promise.reject(new Error("db")) : Promise.resolve(result))
  for (const m of ["select", "eq"]) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, ...a])
      return q
    }
  }
  q.maybeSingle = () => {
    calls.push(["maybeSingle"])
    return settle()
  }
  const client = {
    from: (t: string) => {
      calls.push(["from", t])
      return q
    },
  }
  return { client, calls }
}

/** Minimal in-memory BillsDeps for the REAL payBill (autoFulfil off: no Hubtel call). */
function fakeBills() {
  const orders: (BillOrderRow & { verify_token_hash?: string })[] = []
  const calls = { insert: 0, debit: 0, find: 0, insertRows: [] as any[] }
  const d: BillsDeps = {
    getCashbackConfig: async () => resolveCashbackConfig({}),
    getBuyerTier: async () => "customer",
    getBillsConfig: async () =>
      resolveBillsConfig({ enabled: true, autoFulfil: false, billers: { dstv: { enabled: true, min: 5, max: 1000 } } }),
    getHubtelConfig: async () => ({ enabled: true, paused: false, services: { bill_dstv: true } }),
    query: async () => {
      throw new Error("not used")
    },
    purchase: async () => {
      throw new Error("not used")
    },
    insertOrder: async (row) => {
      calls.insert++
      calls.insertRows.push(row)
      if (orders.some((o) => o.verify_token_hash === row.verify_token_hash)) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" })
      }
      const o = { ...row, id: `o${orders.length + 1}`, hubtel_client_reference: null, commission: null, failure_reason: null, notes: null, created_at: "c", updated_at: "u" } as any
      orders.push(o)
      return { ...o }
    },
    getOrder: async (id) => orders.find((o) => o.id === id) ?? null,
    findApiOrderByTokenHash: async (userId, hash) => {
      calls.find++
      const o = orders.find((x) => x.user_id === userId && x.verify_token_hash === hash && x.channel === "api")
      return o ? { ...o } : null
    },
    updateOrder: async () => 1,
    debitOrder: async (id) => {
      calls.debit++
      const o = orders.find((x) => x.id === id)!
      o.payment_status = "paid"
      return "ok"
    },
    alert: async () => {},
    newReference: () => `BILL-T${orders.length + 1}`,
    secret: SECRET,
    now: () => NOW,
  }
  return { d, orders, calls }
}

const tokenFor = (userId = "user-1") =>
  signBillToken(
    { userId, biller: "dstv", account: SMARTCARD, phone: null, email: null, broadbandAccount: null, sessionId: null, customerName: "Kofi", verified: true, issuedAt: NOW },
    SECRET
  )

describe("bill order read", () => {
  it("selects only the allow-listed columns", () => {
    expect(BILL_ORDER_V2_COLUMNS.split(",").map((s) => s.trim()).sort()).toEqual(
      // payment_status is read only to resolve an unknown claim (paid => show the order); it is never returned.
      ["account_number", "amount", "biller", "cashback_amount", "created_at", "customer_name", "paid_amount", "payment_status", "reference_code", "status"]
    )
  })

  it("is owner-scoped on hubtel_bill_orders by user_id and reference_code", async () => {
    const row = { reference_code: "BILL-1" }
    const { client, calls } = fakeClient({ data: row, error: null })
    expect(await fetchBillOrderByCode(client as any, "user-1", "BILL-1")).toEqual(row)
    expect(calls).toContainEqual(["from", "hubtel_bill_orders"])
    expect(calls).toContainEqual(["select", BILL_ORDER_V2_COLUMNS])
    expect(calls).toContainEqual(["eq", "user_id", "user-1"])
    expect(calls).toContainEqual(["eq", "reference_code", "BILL-1"])
  })

  it("null when missing, on a read error, or on a throw", async () => {
    expect(await fetchBillOrderByCode(fakeClient({ data: null, error: null }).client as any, "u", "c")).toBeNull()
    expect(await fetchBillOrderByCode(fakeClient({ data: null, error: { code: "X" } }).client as any, "u", "c")).toBeNull()
    expect(await fetchBillOrderByCode(fakeClient("throw").client as any, "u", "c")).toBeNull()
  })
})

describe("payBillTracked (real payBill, fake BillsDeps)", () => {
  it("a new payment inserts one api-channel order, debits once and reports fresh", async () => {
    const f = fakeBills()
    const r = await payBillTracked(f.d, { userId: "user-1", verifyToken: tokenFor(), amount: 50, channel: "api" })
    expect(r.fresh).toBe(true)
    expect(r.result.ok).toBe(true)
    if (!r.result.ok) throw new Error("x")
    expect(r.result.order.id).toBe("o1")
    expect(f.calls.insertRows[0].channel).toBe("api")
    expect(f.calls.insert).toBe(1)
    expect(f.calls.debit).toBe(1)
  })

  it("the same token again returns the EARLIER order: fresh false, no second insert or debit", async () => {
    const f = fakeBills()
    const token = tokenFor()
    await payBillTracked(f.d, { userId: "user-1", verifyToken: token, amount: 50, channel: "api" })
    const again = await payBillTracked(f.d, { userId: "user-1", verifyToken: token, amount: 50, channel: "api" })
    expect(again.result.ok).toBe(true)
    expect(again.fresh).toBe(false)
    expect(f.calls.insert).toBe(1)
    expect(f.calls.debit).toBe(1)
  })

  it("a concurrent winner (insert 23505) hands back its order: fresh false, no debit by the loser", async () => {
    const f = fakeBills()
    const token = tokenFor()
    await payBillTracked(f.d, { userId: "user-1", verifyToken: token, amount: 50, channel: "api" })
    const f2 = { ...f.d }
    let miss = true
    f2.findApiOrderByTokenHash = async (u, h) => {
      if (miss) {
        miss = false
        return null
      }
      return f.d.findApiOrderByTokenHash!(u, h)
    }
    const loser = await payBillTracked(f2, { userId: "user-1", verifyToken: token, amount: 50, channel: "api" })
    expect(loser.result.ok).toBe(true)
    expect(loser.fresh).toBe(false)
    expect(f.calls.insert).toBe(2) // the loser's insert attempt hit the unique index
    expect(f.calls.debit).toBe(1)
  })

  it("passes expected_pay to payBill: a mismatch is a 409 quote before any insert", async () => {
    const f = fakeBills()
    const r = await payBillTracked(f.d, { userId: "user-1", verifyToken: tokenFor(), amount: 50, expectedPay: 49, channel: "api" })
    expect(r.result).toMatchObject({ ok: false, status: 409, quote: { faceAmount: 50, payAmount: 50 } })
    expect(r.fresh).toBe(false)
    expect(f.calls.insert).toBe(0)
  })

  it("another user's token is refused (400) before any insert", async () => {
    const f = fakeBills()
    const r = await payBillTracked(f.d, { userId: "user-1", verifyToken: tokenFor("user-2"), amount: 50, channel: "api" })
    expect(r.result).toMatchObject({ ok: false, status: 400 })
    expect(f.calls.insert).toBe(0)
  })

  it("does not mutate the runtime deps it wraps", async () => {
    const f = fakeBills()
    const insert = f.d.insertOrder
    await payBillTracked(f.d, { userId: "user-1", verifyToken: tokenFor(), amount: 50, channel: "api" })
    expect(f.d.insertOrder).toBe(insert)
  })
})

describe("gates", () => {
  it("surfaceOpenFrom: open only when cashback and its api surface are on; a read failure is closed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await surfaceOpenFrom(async () => resolveCashbackConfig({ enabled: true, surfaces: { api: true } }))).toBe(true)
    expect(await surfaceOpenFrom(async () => resolveCashbackConfig({ enabled: true, surfaces: { api: false } }))).toBe(false)
    expect(await surfaceOpenFrom(async () => resolveCashbackConfig({ enabled: false, surfaces: { api: true } }))).toBe(false)
    expect(
      await surfaceOpenFrom(async () => {
        throw new Error("db")
      })
    ).toBe(false)
  })

  it("realBillsPhoneGate: only allowed === true passes; a throw blocks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    checkPhoneVerified.mockResolvedValueOnce({ allowed: true })
    expect(await realBillsPhoneGate({}, "user-1")).toBe(true)
    expect(checkPhoneVerified).toHaveBeenLastCalledWith({}, "user-1")
    checkPhoneVerified.mockResolvedValueOnce({ allowed: false, error: "verify" })
    expect(await realBillsPhoneGate({}, "user-1")).toBe(false)
    checkPhoneVerified.mockRejectedValueOnce(new Error("down"))
    expect(await realBillsPhoneGate({}, "user-1")).toBe(false)
  })
})
