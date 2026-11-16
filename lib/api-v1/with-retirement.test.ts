import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const auth = vi.hoisted(() => ({ authenticateApiKey: vi.fn(), logApiRequest: vi.fn() }))
const cfgMock = vi.hoisted(() => ({ getV1RetirementConfig: vi.fn() }))
vi.mock("@/lib/api-auth", () => auth)
vi.mock("./retirement", async (orig) => ({
  ...(await orig<typeof import("./retirement")>()),
  getV1RetirementConfig: cfgMock.getV1RetirementConfig,
}))

import { withV1Retirement } from "./with-retirement"
import { noticeText, retiredBody } from "./retirement"

const SUNSET = new Date("2026-11-26T00:00:00Z")
const user = { id: "u1", api_key_id: "k1" }
const mkReq = () => new NextRequest("https://x.test/api/v1/orders", { headers: { "x-api-key": "dg_live_x" } })

beforeEach(() => {
  vi.useRealTimers()
  auth.authenticateApiKey.mockReset()
  auth.logApiRequest.mockReset()
  cfgMock.getV1RetirementConfig.mockReset()
})

describe("withV1Retirement", () => {
  it("blocked: 410 + body + headers, handler not called, logged 410", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-27T00:00:00Z"))
    auth.authenticateApiKey.mockResolvedValue(user)
    cfgMock.getV1RetirementConfig.mockResolvedValue({ sunsetAt: SUNSET, exemptUserIds: [] })
    const handler = vi.fn()
    const res = await withV1Retirement("GET /api/v1/orders", handler)(mkReq(), {})
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual(retiredBody(SUNSET))
    expect(res.headers.get("Sunset")).toBe(SUNSET.toUTCString())
    expect(handler).not.toHaveBeenCalled()
    expect(auth.logApiRequest).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 410, userId: "u1" }))
  })

  it("exempt after sunset: body byte-identical, Sunset header present", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-27T00:00:00Z"))
    auth.authenticateApiKey.mockResolvedValue(user)
    cfgMock.getV1RetirementConfig.mockResolvedValue({ sunsetAt: SUNSET, exemptUserIds: ["u1"] })
    const original = { success: true, data: [1, 2] }
    const res = await withV1Retirement("GET /api/v1/orders", async () => NextResponse.json(original))(mkReq(), {})
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(JSON.stringify(original))
    expect(res.headers.get("Sunset")).toBe(SUNSET.toUTCString())
    expect(res.headers.get("Deprecation")).toBe("true")
  })

  it("notice: adds top-level notice and keeps original fields", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-20T00:00:00Z"))
    auth.authenticateApiKey.mockResolvedValue(user)
    cfgMock.getV1RetirementConfig.mockResolvedValue({ sunsetAt: SUNSET, exemptUserIds: [] })
    const res = await withV1Retirement("GET /api/v1/orders", async () => NextResponse.json({ success: true, a: 1 }, { status: 201 }))(mkReq(), {})
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, a: 1, notice: noticeText(SUNSET) })
    expect(res.headers.get("Link")).toContain("successor-version")
  })

  it("notice: array JSON gets headers only", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-20T00:00:00Z"))
    auth.authenticateApiKey.mockResolvedValue(user)
    cfgMock.getV1RetirementConfig.mockResolvedValue({ sunsetAt: SUNSET, exemptUserIds: [] })
    const res = await withV1Retirement("GET /x", async () => NextResponse.json([1, 2]))(mkReq(), {})
    expect(await res.text()).toBe("[1,2]")
    expect(res.headers.get("Sunset")).toBe(SUNSET.toUTCString())
  })

  it("unauthenticated after sunset: handler's own 401 passes through", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-27T00:00:00Z"))
    auth.authenticateApiKey.mockResolvedValue(null)
    cfgMock.getV1RetirementConfig.mockResolvedValue({ sunsetAt: SUNSET, exemptUserIds: [] })
    const handler = vi.fn(async () => NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    const res = await withV1Retirement("GET /x", handler)(mkReq(), {})
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
    expect(res.headers.get("Sunset")).toBeNull()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("non-JSON 500 during notice: status, body and headers preserved", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-20T00:00:00Z"))
    auth.authenticateApiKey.mockResolvedValue(user)
    cfgMock.getV1RetirementConfig.mockResolvedValue({ sunsetAt: SUNSET, exemptUserIds: [] })
    const res = await withV1Retirement("GET /x", async () => new Response("boom", { status: 500 }))(mkReq(), {})
    expect(res.status).toBe(500)
    expect(await res.text()).toBe("boom")
    expect(res.headers.get("Sunset")).toBe(SUNSET.toUTCString())
  })

  it("config null: response identical, no headers", async () => {
    auth.authenticateApiKey.mockResolvedValue(user)
    cfgMock.getV1RetirementConfig.mockResolvedValue(null)
    const res = await withV1Retirement("GET /x", async () => NextResponse.json({ ok: 1 }))(mkReq(), {})
    expect(await res.text()).toBe('{"ok":1}')
    expect(res.headers.get("Sunset")).toBeNull()
    expect(res.headers.get("Deprecation")).toBeNull()
  })

  it("passes ctx through to the handler", async () => {
    auth.authenticateApiKey.mockResolvedValue(user)
    cfgMock.getV1RetirementConfig.mockResolvedValue(null)
    const handler = vi.fn(async () => NextResponse.json({}))
    const ctx = { params: Promise.resolve({ reference: "r" }) }
    await withV1Retirement("GET /x", handler)(mkReq(), ctx)
    expect(handler).toHaveBeenCalledWith(expect.anything(), ctx)
  })
})
