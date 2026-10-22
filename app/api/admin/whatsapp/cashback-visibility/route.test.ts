// /api/admin/whatsapp/cashback-visibility: the WhatsApp bots' cashback switches (admin_settings
// `whatsapp_cashback_visibility`). Admin only (verifyAdminAccess, a rate-limited admin gets the 429); the body is
// validated before any DB access (only the three known keys, booleans, at least one); GET reads the STORED switches
// strictly (a read error is a 500, never shown as "off") plus what the bots offer right now (switch AND gate).
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  auth: { isAdmin: true, userId: "admin-1" } as any,
  stored: { networkPlans: false, payBills: false, cashbackAirtime: false },
  live: { networkPlans: false, payBills: false, cashbackAirtime: false },
  getStrict: vi.fn(),
  set: vi.fn(),
  visible: vi.fn(),
  audit: [] as any[],
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@/lib/whatsapp-bot/cashback-visibility", () => ({
  getWhatsAppCashbackVisibilityStrict: (...a: unknown[]) => h.getStrict(...a),
  setWhatsAppCashbackVisibility: (...a: unknown[]) => h.set(...a),
  whatsappBotItemsVisible: (...a: unknown[]) => h.visible(...a),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: (rows: unknown) => { h.audit.push(rows); return Promise.resolve({ error: null }) } }) }),
}))

import { GET, POST } from "./route"

const URL_ = "http://localhost/api/admin/whatsapp/cashback-visibility"
const post = (body: unknown) => new NextRequest(URL_, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) })

beforeEach(() => {
  h.auth = { isAdmin: true, userId: "admin-1" }
  h.stored = { networkPlans: false, payBills: false, cashbackAirtime: false }
  h.live = { networkPlans: false, payBills: false, cashbackAirtime: false }
  h.getStrict.mockReset().mockImplementation(async () => ({ ...h.stored }))
  h.set.mockReset().mockImplementation(async (_db: unknown, patch: any) => { h.stored = { ...h.stored, ...patch } })
  h.visible.mockReset().mockImplementation(async () => ({ ...h.live }))
  h.audit = []
})

describe("GET", () => {
  it("returns the stored switches and what the bots offer right now", async () => {
    h.stored = { networkPlans: true, payBills: false, cashbackAirtime: true }
    h.live = { networkPlans: true, payBills: false, cashbackAirtime: false }
    const res = await GET(new NextRequest(URL_))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ switches: h.stored, live: h.live })
  })

  it("a read error is a 500 (never shown as all off)", async () => {
    h.getStrict.mockRejectedValueOnce(new Error("db down"))
    const res = await GET(new NextRequest(URL_))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("db down")
  })

  it("non-admin: the auth response, nothing read", async () => {
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
    expect((await GET(new NextRequest(URL_))).status).toBe(403)
    expect(h.getStrict).not.toHaveBeenCalled()
  })

  it("a rate-limited admin (isAdmin true + 429) gets the 429", async () => {
    h.auth = { isAdmin: true, userId: "admin-1", errorResponse: NextResponse.json({ error: "Too many requests" }, { status: 429 }) }
    expect((await GET(new NextRequest(URL_))).status).toBe(429)
    expect(h.getStrict).not.toHaveBeenCalled()
  })
})

describe("POST", () => {
  it("saves one switch, audits it, returns the new switches and the live view", async () => {
    h.live = { networkPlans: false, payBills: true, cashbackAirtime: false }
    const res = await POST(post({ payBills: true }))
    expect(res.status).toBe(200)
    expect(h.set).toHaveBeenCalledTimes(1)
    expect(h.set.mock.calls[0][1]).toEqual({ payBills: true })
    expect(await res.json()).toEqual({ switches: { networkPlans: false, payBills: true, cashbackAirtime: false }, live: h.live })
    expect(h.audit).toHaveLength(1)
    expect(h.audit[0][0]).toMatchObject({
      admin_id: "admin-1", action: "whatsapp_cashback_visibility_update",
      old_value: { networkPlans: false, payBills: false, cashbackAirtime: false },
      new_value: { networkPlans: false, payBills: true, cashbackAirtime: false },
    })
  })

  it("saves several switches at once", async () => {
    const res = await POST(post({ networkPlans: true, cashbackAirtime: false }))
    expect(res.status).toBe(200)
    expect(h.set.mock.calls[0][1]).toEqual({ networkPlans: true, cashbackAirtime: false })
  })

  it("rejects bad bodies with 400 and writes nothing", async () => {
    const bad: unknown[] = [
      "not json", null, 5, "x", [], [true], {},
      { networkPlans: "true" }, { payBills: 1 }, { cashbackAirtime: null },
      { airtime: true }, { networkPlans: true, extra: true }, { __proto__x: true },
    ]
    for (const body of bad) {
      const res = await POST(post(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(h.set).not.toHaveBeenCalled()
    expect(h.getStrict).not.toHaveBeenCalled()
    expect(h.audit).toHaveLength(0)
  })

  it("non-admin / rate-limited admin: the auth response, nothing written", async () => {
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
    expect((await POST(post({ payBills: true }))).status).toBe(403)
    h.auth = { isAdmin: true, userId: "admin-1", errorResponse: NextResponse.json({ error: "Too many requests" }, { status: 429 }) }
    expect((await POST(post({ payBills: true }))).status).toBe(429)
    expect(h.set).not.toHaveBeenCalled()
  })

  it("a write error is a 500 without the DB text", async () => {
    h.set.mockRejectedValueOnce(new Error("permission denied for table admin_settings"))
    const res = await POST(post({ payBills: true }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("permission denied")
    expect(h.audit).toHaveLength(0)
  })
})
