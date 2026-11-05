import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => verifyMock(...a) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({ insert: async () => ({ error: null }) }) } }))

const REF = "0123456789abcdef0123456789abcdef"
const h = vi.hoisted(() => ({ calls: [] as string[], handler: 0 }))
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
      log: () => {},
      checkStatus: async () => (globalThis as any).__status,
      onChargeSuccess: async () => { h.handler++; return null },
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
      },
    }),
  }
})

import { GET, POST } from "./route"
import * as review from "@/lib/hubtel-pay/review"

const post = (body: unknown) => new NextRequest("http://x/api/admin/gateway/hubtel-payments", { method: "POST", body: JSON.stringify(body) })
const PAID = { kind: "paid", amountPesewas: 101, chargesPesewas: 1, paymentMethod: "mobilemoney", raw: {} }

beforeEach(() => {
  verifyMock.mockResolvedValue({ isAdmin: true, userId: "admin-1" })
  h.handler = 0
  ;(review as any).__reset(PAID)
})

describe("/api/admin/gateway/hubtel-payments", () => {
  it("non-admins are refused on GET and every POST action, and nothing runs", async () => {
    verifyMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "no" }, { status: 403 }) })
    expect((await GET(new NextRequest("http://x/api/admin/gateway/hubtel-payments")))!.status).toBe(403)
    for (const action of ["recheck", "fulfil", "mark_failed"]) {
      expect((await POST(post({ action, reference: REF })))!.status).toBe(403)
    }
    expect(h.handler).toBe(0)
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
