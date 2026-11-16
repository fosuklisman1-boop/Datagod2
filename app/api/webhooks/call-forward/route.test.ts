import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const ingestMock = vi.fn()
vi.mock("@/lib/momo-claim/ingest", () => ({ ingestForwardedSms: (...a: unknown[]) => ingestMock(...a) }))
vi.mock("@/lib/momo-claim/settings", () => ({ loadMomoClaimSettings: (...a: unknown[]) => ingestMock(...a) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { tag: "admin-client" } }))

const ttbSettingsMock = vi.fn()
vi.mock("@/lib/text-to-buy/settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/text-to-buy/settings")>("@/lib/text-to-buy/settings")
  return { ...actual, loadTtbSettings: (...a: unknown[]) => ttbSettingsMock(...a) }
})
const heartbeatMock = vi.fn()
vi.mock("@/lib/text-to-buy/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/text-to-buy/store")>("@/lib/text-to-buy/store")
  return { ...actual, touchHeartbeat: (...a: unknown[]) => heartbeatMock(...a) }
})
const handleMock = vi.fn()
vi.mock("@/lib/text-to-buy/call/decide", async () => {
  const actual = await vi.importActual<typeof import("@/lib/text-to-buy/call/decide")>("@/lib/text-to-buy/call/decide")
  return { ...actual, handleMissedCall: (...a: unknown[]) => handleMock(...a) }
})
const depsMock = vi.fn()
vi.mock("@/lib/text-to-buy/call/default-deps", () => ({ defaultCallDeps: (...a: unknown[]) => depsMock(...a) }))

import { POST } from "./route"

const SECRET = "s3cret-value-for-tests-0123456789"
const SHOP_SECRET = "shop-secret-for-tests-9876543210"
const URL_ = "http://localhost/api/webhooks/call-forward"
const CALLER = "0241234567"

const jsonReq = (body: unknown, headers: Record<string, string> = { "x-sms-forward-secret": SECRET }) =>
  new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
const formReq = (body: string, headers: Record<string, string> = { "x-sms-forward-secret": SECRET }) =>
  new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body })

let logSpies: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
  vi.clearAllMocks()
  process.env.SMS_FORWARD_SECRET = SECRET
  process.env.SMS_FORWARD_SECRET_SHOP = SHOP_SECRET
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder"
  ttbSettingsMock.mockResolvedValue({ callsEnabled: true })
  heartbeatMock.mockResolvedValue(undefined)
  depsMock.mockReturnValue({ tag: "deps" })
  handleMock.mockResolvedValue({ outcome: "replied_main" })
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => {
  delete process.env.SMS_FORWARD_SECRET
  delete process.env.SMS_FORWARD_SECRET_MAIN
  delete process.env.SMS_FORWARD_SECRET_SHOP
  for (const spy of logSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(CALLER)
    spy.mockRestore()
  }
})

describe("POST /api/webhooks/call-forward", () => {
  it("401s a wrong, empty and missing secret", async () => {
    expect((await POST(jsonReq({ from: CALLER }, { "x-sms-forward-secret": "wrong" }))).status).toBe(401)
    expect((await POST(jsonReq({ from: CALLER }, { "x-sms-forward-secret": "" }))).status).toBe(401)
    expect((await POST(jsonReq({ from: CALLER }, {}))).status).toBe(401)
    delete process.env.SMS_FORWARD_SECRET
    expect((await POST(jsonReq({ from: CALLER }, { "x-sms-forward-secret": "" }))).status).toBe(401)
    expect(handleMock).not.toHaveBeenCalled()
    expect(heartbeatMock).not.toHaveBeenCalled()
  })

  it("primary secret is the main line: heartbeat main, handler called with main", async () => {
    const res = await POST(jsonReq({ from: CALLER, received: "2026-11-15T10:00:00Z" }))
    expect(res.status).toBe(200)
    expect(heartbeatMock.mock.calls[0][1]).toBe("main")
    const input = handleMock.mock.calls[0][1]
    expect(input.line).toBe("main")
    expect(input.fromRaw).toBe(CALLER)
    expect(input.receivedMs).toBe(Date.parse("2026-11-15T10:00:00Z"))
    expect(typeof input.nowMs).toBe("number")
  })

  it("shop secret is the shop line", async () => {
    const res = await POST(jsonReq({ from: CALLER }, { "x-sms-forward-secret": SHOP_SECRET }))
    expect(res.status).toBe(200)
    expect(heartbeatMock.mock.calls[0][1]).toBe("shop")
    expect(handleMock.mock.calls[0][1].line).toBe("shop")
  })

  it("a shop secret equal to the primary secret is main", async () => {
    process.env.SMS_FORWARD_SECRET_SHOP = SECRET
    await POST(jsonReq({ from: CALLER }))
    expect(handleMock.mock.calls[0][1].line).toBe("main")
  })

  it("reads a form-encoded body", async () => {
    const res = await POST(formReq(`from=${CALLER}&received=1763200000`))
    expect(res.status).toBe(200)
    const input = handleMock.mock.calls[0][1]
    expect(input.fromRaw).toBe(CALLER)
    expect(input.receivedMs).toBe(1763200000 * 1000)
  })

  it("a missing or garbage received time passes null", async () => {
    await POST(jsonReq({ from: CALLER }))
    await POST(jsonReq({ from: CALLER, received: "yesterday-ish" }))
    expect(handleMock.mock.calls[0][1].receivedMs).toBeNull()
    expect(handleMock.mock.calls[1][1].receivedMs).toBeNull()
  })

  it("never touches the MoMo ingest, even for a MoMo-shaped body", async () => {
    const res = await POST(jsonReq({ text: "Payment received for GHS 50.00 Transaction ID: 80000000123.", from: "MobileMoney" }))
    expect(res.status).toBe(200)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it("answers 200 and does nothing when the body has no usable from", async () => {
    expect((await POST(jsonReq({}))).status).toBe(200)
    expect((await POST(jsonReq({ received: "1763200000" }))).status).toBe(200)
    expect((await POST(formReq(""))).status).toBe(200)
    expect(handleMock).not.toHaveBeenCalled()
  })

  it("answers 200 when the handler reports the switch off (nothing replied)", async () => {
    handleMock.mockResolvedValue({ outcome: "skipped_off" })
    expect((await POST(jsonReq({ from: CALLER }))).status).toBe(200)
  })

  it("answers 200 when settings cannot be read, without handling", async () => {
    ttbSettingsMock.mockRejectedValue(new Error(`boom ${CALLER}`))
    expect((await POST(jsonReq({ from: CALLER }))).status).toBe(200)
    expect(handleMock).not.toHaveBeenCalled()
  })

  it("swallows a handler throw and a heartbeat throw (200, no numbers logged)", async () => {
    handleMock.mockRejectedValue(new Error(`exploded for ${CALLER}`))
    expect((await POST(jsonReq({ from: CALLER }))).status).toBe(200)
    heartbeatMock.mockRejectedValue(new Error(`hb ${CALLER}`))
    handleMock.mockResolvedValue({ outcome: "replied_main" })
    expect((await POST(jsonReq({ from: CALLER }))).status).toBe(200)
    expect(handleMock).toHaveBeenCalledTimes(2)
  })
})
