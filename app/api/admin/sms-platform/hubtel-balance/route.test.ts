import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  guard: { ok: true, adminId: "admin1" } as any,
  guardOpts: [] as any[],
  resolved: { ok: true, amountGhs: 35, source: "relay" } as any,
  settings: { settings: { hubtelManualBalance: null } } as any,
  settingsThrows: false,
  relay: { ok: true, amountGhs: 35 } as any,
}))
vi.mock("@/lib/sms/admin-guard", () => ({
  adminGuard: (_req: any, opts: any) => { h.guardOpts.push(opts); return Promise.resolve(h.guard) },
}))
vi.mock("@/lib/sms/wholesale", () => ({ resolveHubtelBalance: () => Promise.resolve(h.resolved) }))
vi.mock("@/lib/ussd-hubtel/relay", () => ({ fetchDisbursementBalance: () => Promise.resolve(h.relay) }))
vi.mock("@/lib/sms/admin-settings", () => ({
  getAdminSettings: () => (h.settingsThrows ? Promise.reject(new Error("down")) : Promise.resolve(h.settings)),
}))

import { GET } from "./route"

const call = () => GET(new NextRequest("http://localhost/api/admin/sms-platform/hubtel-balance"))

beforeEach(() => {
  h.guard = { ok: true, adminId: "admin1" }; h.guardOpts = []
  h.resolved = { ok: true, amountGhs: 35, source: "relay" }
  h.settings = { settings: { hubtelManualBalance: null } }; h.settingsThrows = false
  h.relay = { ok: true, amountGhs: 35 }
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("GET /api/admin/sms-platform/hubtel-balance", () => {
  it("requires an admin", async () => {
    h.guard = { ok: false, response: NextResponse.json({ success: false, error: "Admin access required" }, { status: 403 }) }
    expect((await call()).status).toBe(403)
  })
  it("returns the resolved balance and no manual value", async () => {
    const body = await (await call()).json()
    expect(body).toEqual({ success: true, data: {
      current: { ok: true, amountGhs: 35, source: "relay" }, manual: null, preferManual: false, relay: { ok: true, amountGhs: 35 },
    } })
  })
  it("prefer-manual: reports the flag; the relay reading is informational only", async () => {
    const setAt = new Date(Date.now() - 3_600_000).toISOString()
    h.settings = { settings: { hubtelManualBalance: { amountGhs: 80, setAt, setBy: "a" }, hubtelPreferManualBalance: true } }
    h.resolved = { ok: true, amountGhs: 72.5, source: "manual", manualSetAt: setAt, preferred: true }
    h.relay = { ok: true, amountGhs: 0 }
    const d = (await (await call()).json()).data
    expect(d.preferManual).toBe(true)
    expect(d.current).toMatchObject({ source: "manual", amountGhs: 72.5 })
    expect(d.relay).toEqual({ ok: true, amountGhs: 0 })
  })
  it("relay reading errors are passed through as info", async () => {
    h.relay = { ok: false, error: "relay not configured" }
    expect((await (await call()).json()).data.relay).toEqual({ ok: false, error: "relay not configured" })
  })
  it("returns the stored manual balance with a freshness flag", async () => {
    const setAt = new Date(Date.now() - 3_600_000).toISOString()
    h.settings = { settings: { hubtelManualBalance: { amountGhs: 80, setAt, setBy: "admin-7" } } }
    h.resolved = { ok: true, amountGhs: 72.5, source: "manual", manualSetAt: setAt }
    const body = await (await call()).json()
    expect(body.data.manual).toEqual({ amountGhs: 80, setAt, setBy: "admin-7", fresh: true })
    expect(body.data.current.source).toBe("manual")
  })
  it("flags a stale manual balance as not fresh", async () => {
    const setAt = new Date(Date.now() - 40 * 86_400_000).toISOString()
    h.settings = { settings: { hubtelManualBalance: { amountGhs: 80, setAt, setBy: "admin-7" } } }
    expect((await (await call()).json()).data.manual.fresh).toBe(false)
  })
  it("500 when the settings can't be read", async () => {
    h.settingsThrows = true
    const res = await call()
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })
})
