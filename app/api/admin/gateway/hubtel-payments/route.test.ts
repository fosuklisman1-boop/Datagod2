import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => verifyMock(...a) }))
const h = vi.hoisted(() => ({ calls: [] as string[], handler: 0, audit: [] as unknown[], closed: [] as string[], logs: [] as unknown[] }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({ insert: async (rows: unknown[]) => { h.audit.push(...rows); return { error: null } } }) } }))

const REF = "0123456789abcdef0123456789abcdef"
vi.mock("@/lib/hubtel-pay/review", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/hubtel-pay/review")>()
  // The real lib with an in-memory store: the route must reach it only for admins.
  let row: any = null
  return {
    ...real,
    __reset: (status: any) => {
      row = { reference: REF, internal_reference: "WALLET-1", surface: "wallet_topup", amount_pesewas: 100, handler_amount_pesewas: null, metadata: null, status: "needs_review", last_check: null, created_at: "2026-11-05T11:00:00Z", claimed_at: null }
      ;(globalThis as any).__status = status
    },
    defaultReviewDeps: async () => ({
      now: () => new Date("2026-11-05T12:00:00Z"),
      log: (...a: unknown[]) => { h.logs.push(a) },
      checkStatus: async () => (globalThis as any).__status,
      onChargeSuccess: async () => { h.handler++; return null },
      closeWalletPayment: async (r: string) => { h.closed.push(r) },
      store: {
        listOpen: async () => (row ? [row] : []),
        load: async () => (row ? { ...row } : null),
        take: (r: any) => {
          if (row.status !== r.status) return Promise.resolve(null)
          row = { ...row, status: "confirming", claimed_at: "c1" }
          return Promise.resolve("c1")
        },
        update: async (_r: string, patch: any, guard: any) => {
          if (!guard.status.includes(row.status)) return false
          row = { ...row, ...patch }
          return true
        },
        hasPaidSibling: async () => false,
        orderPaymentFacts: async () => (globalThis as any).__order ?? null,
      },
    }),
    __row: () => row,
  }
})

import { GET, POST } from "./route"
import * as review from "@/lib/hubtel-pay/review"

const post = (body: unknown) => new NextRequest("http://x/api/admin/gateway/hubtel-payments", { method: "POST", body: JSON.stringify(body) })
const PAID = { kind: "paid", amountPesewas: 101, chargesPesewas: 1, paymentMethod: "mobilemoney", raw: {} }

beforeEach(() => {
  verifyMock.mockResolvedValue({ isAdmin: true, userId: "admin-1" })
  h.handler = 0
  h.audit.length = 0
  h.closed.length = 0
  h.logs.length = 0
  ;(globalThis as any).__order = null
  ;(review as any).__reset(PAID)
})

const SECOND = { orderStatus: "completed", paymentStatus: "completed", ownPaymentCompleted: false, otherPaymentCompleted: true, refundCompleted: false }
const MANUAL = { action: "refunded_manually", reference: REF, admin_reference: "MP241105.1234.A56789", note: "Paid back by MoMo after a double payment" }

describe("/api/admin/gateway/hubtel-payments", () => {
  it("non-admins are refused on GET and every POST action, and nothing runs", async () => {
    verifyMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "no" }, { status: 403 }) })
    expect((await GET(new NextRequest("http://x/api/admin/gateway/hubtel-payments")))!.status).toBe(403)
    for (const action of ["recheck", "fulfil", "mark_failed", "refunded_manually"]) {
      expect((await POST(post({ ...MANUAL, action })))!.status).toBe(403)
    }
    expect(h.handler).toBe(0)
    expect((review as any).__row().status).toBe("needs_review")
    expect(h.audit).toHaveLength(0)
  })

  it("refunded_manually: the cron secret can't do it either", async () => {
    verifyMock.mockResolvedValue({ isAdmin: true })
    expect((await POST(post(MANUAL)))!.status).toBe(403)
    expect((review as any).__row().status).toBe("needs_review")
  })

  it("refunded_manually: records a second payment, moves no money, closes the wallet row", async () => {
    ;(globalThis as any).__order = SECOND
    const res = await POST(post(MANUAL))
    expect(res!.status).toBe(200)
    const row = (review as any).__row()
    expect(row.status).toBe("refunded_manually")
    expect(row.manual_refund).toMatchObject({ admin_reference: MANUAL.admin_reference, note: MANUAL.note, admin_id: "admin-1" })
    expect(h.closed).toEqual(["WALLET-1"])
    expect(h.handler).toBe(0)
  })

  it("refunded_manually: the audit row and logs hold the admin id and opaque reference, not what the admin typed", async () => {
    ;(globalThis as any).__order = SECOND
    await POST(post(MANUAL))
    expect(h.audit).toHaveLength(1)
    expect(h.audit[0]).toMatchObject({ admin_id: "admin-1", action: "hubtel_payment_refunded_manually", old_value: { reference: REF }, new_value: { ok: true } })
    const written = JSON.stringify([h.audit, h.logs])
    expect(written).not.toContain(MANUAL.admin_reference)
    expect(written).not.toContain(MANUAL.note)
  })

  it("refunded_manually: refused on an order's only payment, and a refusal is audited too", async () => {
    const res = await POST(post(MANUAL))
    expect(res!.status).toBe(409)
    expect((await res!.json()).error).toMatch(/only payment/)
    expect((review as any).__row().status).toBe("needs_review")
    expect(h.audit[0]).toMatchObject({ new_value: { ok: false } })
  })

  it("refunded_manually: a missing reference or note is a 400", async () => {
    ;(globalThis as any).__order = SECOND
    expect((await POST(post({ action: "refunded_manually", reference: REF, note: MANUAL.note })))!.status).toBe(400)
    expect((await POST(post({ action: "refunded_manually", reference: REF, admin_reference: MANUAL.admin_reference })))!.status).toBe(400)
    expect((review as any).__row().status).toBe("needs_review")
  })

  it("refunded_manually: two clicks, one write", async () => {
    ;(globalThis as any).__order = SECOND
    const [a, b] = await Promise.all([POST(post(MANUAL)), POST(post(MANUAL))])
    expect([a!.status, b!.status].sort()).toEqual([200, 409])
    expect(h.closed).toHaveLength(1)
  })

  it("the row's new column is not selected by the list, so the list keeps working before the migration is applied", async () => {
    expect(review.REVIEW_COLUMNS).not.toContain("manual_refund")
  })

  it("the cron secret is not an admin here: an actor id is required", async () => {
    verifyMock.mockResolvedValue({ isAdmin: true })
    expect((await POST(post({ action: "fulfil", reference: REF })))!.status).toBe(403)
    expect(h.handler).toBe(0)
  })

  it("lists rows for admins", async () => {
    const res = await GET(new NextRequest("http://x/api/admin/gateway/hubtel-payments"))
    const body = await res!.json()
    expect(body.items[0]).toMatchObject({ reference: REF, internalReference: "WALLET-1", amountGhs: 1 })
  })

  it("fulfil refused when the status check is not Paid", async () => {
    ;(review as any).__reset({ kind: "unpaid", raw: {} })
    const res = await POST(post({ action: "fulfil", reference: REF }))
    expect(res!.status).toBe(409)
    expect(h.handler).toBe(0)
  })

  it("two fulfil clicks: one handler call", async () => {
    const [a, b] = await Promise.all([POST(post({ action: "fulfil", reference: REF })), POST(post({ action: "fulfil", reference: REF }))])
    expect(h.handler).toBe(1)
    expect([a!.status, b!.status].sort()).toEqual([200, 409])
  })

  it("an unknown action or bad body is a 400", async () => {
    expect((await POST(post({ action: "delete", reference: REF })))!.status).toBe(400)
    expect((await POST(new NextRequest("http://x", { method: "POST", body: "nope" })))!.status).toBe(400)
  })
})
