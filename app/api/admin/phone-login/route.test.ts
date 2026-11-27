import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  admin: true as boolean,
  strict: { enabled: true, newDeviceCode: true } as { enabled: boolean; newDeviceCode: boolean },
  strictThrows: false,
  counts: {} as Record<string, number>,
  countsThrow: false,
}))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ tag: "db" }) }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () =>
    h.admin
      ? { isAdmin: true, userId: "admin-1" }
      : { isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
  ),
}))
vi.mock("@/lib/phone-login/settings", () => ({
  getPhoneLoginSettingsStrict: vi.fn(async () => {
    if (h.strictThrows) throw new Error("db down")
    return h.strict
  }),
  setPhoneLoginSettings: vi.fn(async () => {}),
}))
vi.mock("@/lib/phone-login/store", () => ({
  countEvents: vi.fn(async (_db: unknown, kind: string) => {
    if (h.countsThrow) throw new Error("x")
    return h.counts[kind] ?? 0
  }),
  recordEvent: vi.fn(async () => {}),
}))
vi.mock("@/lib/security-alerts", () => ({ raiseSecurityAlert: vi.fn(async () => true) }))

import { GET, POST } from "./route"
import { setPhoneLoginSettings } from "@/lib/phone-login/settings"
import { recordEvent } from "@/lib/phone-login/store"
import { raiseSecurityAlert } from "@/lib/security-alerts"

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/phone-login", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.admin = true
  h.strict = { enabled: true, newDeviceCode: true }
  h.strictThrows = false
  h.counts = {}
  h.countsThrow = false
})

describe("GET /api/admin/phone-login", () => {
  it("rejects non-admins", async () => {
    h.admin = false
    expect((await GET(new NextRequest("http://localhost/x"))).status).toBe(401)
  })
  it("returns settings and 24h counts", async () => {
    h.counts = { login_ok: 5, challenge_sent: 2, challenge_passed: 1, lockout: 3 }
    const r = await GET(new NextRequest("http://localhost/x"))
    expect(await r.json()).toEqual({
      settings: { enabled: true, newDeviceCode: true },
      last24h: { login_ok: 5, challenge_sent: 2, challenge_passed: 1, lockout: 3 },
    })
  })
  it("500s when the settings read fails", async () => {
    h.strictThrows = true
    expect((await GET(new NextRequest("http://localhost/x"))).status).toBe(500)
  })
})

describe("POST /api/admin/phone-login", () => {
  it("rejects non-admins and writes nothing", async () => {
    h.admin = false
    expect((await POST(post({ enabled: true, newDeviceCode: true }))).status).toBe(401)
    expect(setPhoneLoginSettings).not.toHaveBeenCalled()
  })
  it("400s on non-boolean fields", async () => {
    expect((await POST(post({ enabled: "true", newDeviceCode: true }))).status).toBe(400)
    expect((await POST(post({ enabled: true }))).status).toBe(400)
    expect(setPhoneLoginSettings).not.toHaveBeenCalled()
  })
  it("500s with no write when the strict read fails", async () => {
    h.strictThrows = true
    expect((await POST(post({ enabled: true, newDeviceCode: false }))).status).toBe(500)
    expect(setPhoneLoginSettings).not.toHaveBeenCalled()
    expect(raiseSecurityAlert).not.toHaveBeenCalled()
  })
  it("turning the code OFF raises a high alert and records an event", async () => {
    const r = await POST(post({ enabled: true, newDeviceCode: false }))
    expect(r.status).toBe(200)
    expect(setPhoneLoginSettings).toHaveBeenCalledWith(expect.anything(), { enabled: true, newDeviceCode: false })
    expect(raiseSecurityAlert).toHaveBeenCalledWith({
      severity: "high",
      category: "phone_login_code_off",
      title: "Phone login new-device code switched OFF",
      actor: "admin-1",
      detail: { by: "admin-1" },
    })
    expect(recordEvent).toHaveBeenCalledWith(expect.anything(), "code_switch_off", { userId: "admin-1" })
  })
  it("turning the code ON does not alert", async () => {
    h.strict = { enabled: true, newDeviceCode: false }
    const r = await POST(post({ enabled: true, newDeviceCode: true }))
    expect(r.status).toBe(200)
    expect(raiseSecurityAlert).not.toHaveBeenCalled()
    expect(recordEvent).not.toHaveBeenCalled()
  })
  it("leaving the code OFF (already off) does not re-alert", async () => {
    h.strict = { enabled: true, newDeviceCode: false }
    await POST(post({ enabled: false, newDeviceCode: false }))
    expect(raiseSecurityAlert).not.toHaveBeenCalled()
  })
})
