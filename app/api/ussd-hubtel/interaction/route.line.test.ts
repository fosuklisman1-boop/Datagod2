// app/api/ussd-hubtel/interaction/route.line.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ router: vi.fn(), existingGet: vi.fn(), mainGet: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/ussd-hubtel/router", () => ({
  hubtelRouter: (...a: any[]) => h.router(...a),
  defaultRouterDeps: () => ({ getConfig: h.existingGet, sessions: {} }),
}))
vi.mock("@/lib/ussd-hubtel/config", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/ussd-hubtel/config")>()),
  getHubtelMainLineConfig: (...a: any[]) => h.mainGet(...a),
}))
vi.mock("@/lib/ussd-hubtel/interaction-log", () => ({
  logInteraction: async () => {},
  shapeInteractionRow: () => ({}),
  trackSessionStore: (store: unknown) => ({ store, latest: () => null, answered: () => null }),
}))

import { POST } from "./route"

const BODY = { Type: "Initiation", SessionId: "S1", Mobile: "233244123456", Message: "*713#", Platform: "USSD" }
const post = (query: string) =>
  POST(new NextRequest(`http://localhost/api/ussd-hubtel/interaction?${query}`, { method: "POST", body: JSON.stringify(BODY) }))

let prevSecret: string | undefined
beforeEach(() => {
  prevSecret = process.env.HUBTEL_WEBHOOK_SECRET
  process.env.HUBTEL_WEBHOOK_SECRET = "s3cret"
  h.router.mockReset().mockResolvedValue({ SessionId: "S1", Type: "response", Message: "menu", Label: "x", DataType: "input", FieldType: "text" })
  h.existingGet.mockReset()
  h.mainGet.mockReset()
})
afterEach(() => { process.env.HUBTEL_WEBHOOK_SECRET = prevSecret })

describe("POST /api/ussd-hubtel/interaction: line selection", () => {
  it("still refuses a wrong secret with line=main", async () => {
    const res = await post("secret=wrong&line=main")
    expect(res.status).toBe(401)
    expect(h.router).not.toHaveBeenCalled()
  })

  it("uses the existing settings when there is no line", async () => {
    await post("secret=s3cret")
    const deps = h.router.mock.calls[0][1]
    await deps.getConfig()
    expect(h.existingGet).toHaveBeenCalledTimes(1)
    expect(h.mainGet).not.toHaveBeenCalled()
  })

  it("uses only the main line settings with line=main", async () => {
    await post("secret=s3cret&line=main")
    const deps = h.router.mock.calls[0][1]
    await deps.getConfig()
    expect(h.mainGet).toHaveBeenCalledTimes(1)
    expect(h.existingGet).not.toHaveBeenCalled()
  })

  it("refuses an unrecognised line without opening a menu or logging the secret or caller", async () => {
    for (const query of ["line=", "line=MAIN", "line=shop", "line=main&line=shop"]) {
      h.router.mockClear()
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const res = await post(`secret=s3cret&${query}`)
      const warned = JSON.stringify(warn.mock.calls)
      warn.mockRestore()
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.Type).toBe("release")
      expect(body.Message).toBe("Service unavailable. Please try again later.")
      expect(h.router).not.toHaveBeenCalled()
      expect(warned).toContain("[HUBTEL]")
      expect(warned).not.toContain("s3cret")
      expect(warned).not.toContain("233244123456")
    }
  })

  it("answers Service unavailable and never falls back to the existing settings when the main line fails", async () => {
    h.mainGet.mockRejectedValue(new Error("db down"))
    h.router.mockImplementation(async (_req: unknown, deps: any) => { await deps.getConfig(); return {} })
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await post("secret=s3cret&line=main")
    error.mockRestore()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.Type).toBe("release")
    expect(body.Message).toContain("Service unavailable")
    expect(h.existingGet).not.toHaveBeenCalled()
  })
})
