import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  auth: { isAdmin: true, userId: "admin-1" } as any,
  get: vi.fn(), set: vi.fn(), getMain: vi.fn(), setMain: vi.fn(), envReady: vi.fn(),
  audit: [] as any[],
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@/lib/ussd-hubtel/config", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/ussd-hubtel/config")>()),
  getHubtelUssdConfig: (...a: any[]) => h.get(...a),
  setHubtelUssdConfig: (...a: any[]) => h.set(...a),
  getHubtelMainLineConfig: (...a: any[]) => h.getMain(...a),
  setHubtelMainLineConfig: (...a: any[]) => h.setMain(...a),
  hubtelEnvReady: (...a: any[]) => h.envReady(...a),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: (rows: any[]) => { h.audit.push(...rows); return Promise.resolve({ error: null }) } }) }),
}))

import { GET, POST } from "./route"

const SHOP = { enabled: true, mode: "shop", visibility: { afa: false } }
const MAIN = { enabled: false, mode: "main", visibility: { afa: true } }
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/admin/ussd-hubtel/config", { method: "POST", body: JSON.stringify(body) }))
const nothingWritten = () => { expect(h.set).not.toHaveBeenCalled(); expect(h.setMain).not.toHaveBeenCalled() }

beforeEach(() => {
  h.auth = { isAdmin: true, userId: "admin-1" }
  h.get.mockReset().mockResolvedValue(SHOP)
  h.set.mockReset().mockResolvedValue(SHOP)
  h.getMain.mockReset().mockResolvedValue(MAIN)
  h.setMain.mockReset().mockResolvedValue({ ...MAIN, enabled: true })
  h.envReady.mockReset().mockReturnValue({ ready: true, missing: [] })
  h.audit = []
})

describe("GET /api/admin/ussd-hubtel/config", () => {
  it("adds mainLine and leaves config as the existing line's settings", async () => {
    const body = await (await GET(new NextRequest("http://localhost/api/admin/ussd-hubtel/config"))).json()
    expect(body.config).toEqual(SHOP)
    expect(body.mainLine).toEqual(MAIN)
  })
})

describe("POST /api/admin/ussd-hubtel/config: line", () => {
  it("line main writes only the main line and returns mainLine", async () => {
    const res = await post({ line: "main", enabled: true })
    expect(res.status).toBe(200)
    expect((await res.json()).mainLine).toEqual({ ...MAIN, enabled: true })
    expect(h.setMain.mock.calls[0][1]).toMatchObject({ enabled: true })
    expect(h.set).not.toHaveBeenCalled()
  })
  it("no line writes only the existing line and returns config", async () => {
    const res = await post({ enabled: false })
    expect(res.status).toBe(200)
    expect((await res.json()).config).toEqual(SHOP)
    expect(h.setMain).not.toHaveBeenCalled()
  })
  it("refuses mode on the main line", async () => {
    expect((await post({ line: "main", mode: "shop" })).status).toBe(400)
    nothingWritten()
  })
  it("refuses any other line value", async () => {
    for (const line of ["shop", "", null, 1]) {
      expect((await post({ line, enabled: true })).status).toBe(400)
    }
    nothingWritten()
  })
  it("refuses enabling the main line when the env is not ready", async () => {
    h.envReady.mockReturnValue({ ready: false, missing: ["HUBTEL_RELAY_URL"] })
    expect((await post({ line: "main", enabled: true })).status).toBe(400)
    nothingWritten()
  })
  it("validates the main line's visibility, brand and welcome", async () => {
    for (const body of [{ visibility: { nope: true } }, { visibility: { afa: "yes" } }, { brandName: "bad\nbrand" }, { welcome: "x".repeat(61) }]) {
      expect((await post({ line: "main", ...body })).status).toBe(400)
    }
    nothingWritten()
  })
  it("a blank brand resets only the main line to the default", async () => {
    expect((await post({ line: "main", brandName: "  " })).status).toBe(200)
    expect(h.setMain.mock.calls[0][1]).toMatchObject({ brandName: "Clingshub" })
    expect(h.set).not.toHaveBeenCalled()
  })
  it("a blank welcome clears only the main line's override", async () => {
    expect((await post({ line: "main", welcome: "" })).status).toBe(200)
    expect(h.setMain.mock.calls[0][1]).toMatchObject({ welcome: null })
    expect(h.set).not.toHaveBeenCalled()
  })
  it("audits a main line change with its own action and values", async () => {
    await post({ line: "main", enabled: true })
    expect(h.audit[0]).toMatchObject({
      admin_id: "admin-1", action: "hubtel_ussd_main_line_config_update", old_value: MAIN, new_value: { ...MAIN, enabled: true },
    })
  })
  it("walletPayment on the main line saves to the main row only", async () => {
    const res = await post({ line: "main", walletPayment: true })
    expect(res.status).toBe(200)
    expect(h.setMain.mock.calls[0][1]).toMatchObject({ walletPayment: true })
    expect(h.set).not.toHaveBeenCalled()
  })
  it("refuses walletPayment without line main", async () => {
    expect((await post({ walletPayment: true })).status).toBe(400)
    nothingWritten()
  })
  it("refuses a non-boolean walletPayment", async () => {
    for (const walletPayment of ["true", 1, null, {}]) {
      expect((await post({ line: "main", walletPayment })).status).toBe(400)
    }
    nothingWritten()
  })
  it("audits a walletPayment change on the main line", async () => {
    h.setMain.mockResolvedValue({ ...MAIN, walletPayment: true })
    await post({ line: "main", walletPayment: true })
    expect(h.audit[0]).toMatchObject({ action: "hubtel_ussd_main_line_config_update", old_value: MAIN, new_value: { ...MAIN, walletPayment: true } })
  })
  it("rejects a non-admin", async () => {
    h.auth = { isAdmin: false, errorResponse: new Response(null, { status: 403 }) }
    expect((await post({ line: "main", enabled: true })).status).toBe(403)
    nothingWritten()
  })
})
