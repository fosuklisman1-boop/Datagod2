import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeFakeDb } from "@/lib/order-queue/fake-db.test-helper"

const verifyMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => verifyMock(...a) }))

const current = vi.hoisted(() => ({ db: null as any }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => current.db.from(t) }) }))

import { POST } from "./route"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/fulfillment/approval-preview", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
  })

beforeEach(() => {
  verifyMock.mockResolvedValue({ isAdmin: true, userId: "u1" })
  current.db = makeFakeDb({
    admin_settings: [{ key: "mtn_strict_supplier_verification", value: { enabled: true } }],
    orders: [{ id: id(1), network: "MTN", phone_number: "0240000001" }],
    mtn_supplier_verdicts: [{ phone: "0240000001", supplier: "hubnet", verdict: "yes", checked_at: new Date().toISOString() }],
  })
})

describe("POST /api/admin/fulfillment/approval-preview", () => {
  it("rejects non-admins without touching the database", async () => {
    verifyMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "nope" }, { status: 403 }) })
    const res = await POST(post({ orders: [{ id: id(1), type: "bulk" }], supplier: "hubnet" }))
    expect(res.status).toBe(403)
    expect(current.db.calls).toHaveLength(0)
  })

  it("returns counts and per-order status, with no phone numbers", async () => {
    const res = await POST(post({ orders: [{ id: id(1), type: "bulk" }], supplier: "hubnet" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.enabled).toBe(true)
    expect(body.counts).toEqual({ approved: 1, notApproved: 0, notChecked: 0 })
    expect(body.perOrder).toEqual([{ id: id(1), status: "approved" }])
    expect(JSON.stringify(body)).not.toContain("024000")
  })

  it.each([
    ["invalid id", { orders: [{ id: "x", type: "bulk" }], supplier: "hubnet" }],
    ["bad type", { orders: [{ id: id(1), type: "zzz" }], supplier: "hubnet" }],
    ["empty orders", { orders: [], supplier: "hubnet" }],
    ["too many", { orders: Array.from({ length: 201 }, (_, i) => ({ id: id(i + 1), type: "bulk" })), supplier: "hubnet" }],
    ["unknown supplier", { orders: [{ id: id(1), type: "bulk" }], supplier: "nope" }],
    ["missing supplier", { orders: [{ id: id(1), type: "bulk" }] }],
  ])("400 for %s", async (_n, body) => {
    const res = await POST(post(body))
    expect(res.status).toBe(400)
  })

  it("400 for invalid JSON", async () => {
    const res = await POST(post("{not json"))
    expect(res.status).toBe(400)
  })
})
