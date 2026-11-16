import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { tag: "admin-client" } }))
const heartbeatMock = vi.fn()
vi.mock("@/lib/text-to-buy/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/text-to-buy/store")>("@/lib/text-to-buy/store")
  return { ...actual, touchHeartbeat: (...a: unknown[]) => heartbeatMock(...a) }
})

import { POST } from "./route"

const SECRET = "s3cret-value-for-tests-0123456789"
const SHOP_SECRET = "shop-secret-for-tests-9876543210"
const URL_ = "http://localhost/api/webhooks/phone-health"

const req = (headers: Record<string, string> = { "x-sms-forward-secret": SECRET }) =>
  new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: "battery=80" })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SMS_FORWARD_SECRET = SECRET
  process.env.SMS_FORWARD_SECRET_SHOP = SHOP_SECRET
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder"
  heartbeatMock.mockResolvedValue(undefined)
})
afterEach(() => {
  delete process.env.SMS_FORWARD_SECRET
  delete process.env.SMS_FORWARD_SECRET_SHOP
})

describe("POST /api/webhooks/phone-health", () => {
  it("401s a wrong, empty and missing secret and records nothing", async () => {
    expect((await POST(req({ "x-sms-forward-secret": "wrong" }))).status).toBe(401)
    expect((await POST(req({ "x-sms-forward-secret": "" }))).status).toBe(401)
    expect((await POST(req({}))).status).toBe(401)
    expect(heartbeatMock).not.toHaveBeenCalled()
  })

  it("records a heartbeat for the main line", async () => {
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(heartbeatMock).toHaveBeenCalledTimes(1)
    expect(heartbeatMock.mock.calls[0][1]).toBe("main")
  })

  it("records a heartbeat for the shop line with the shop secret", async () => {
    const res = await POST(req({ "x-sms-forward-secret": SHOP_SECRET }))
    expect(res.status).toBe(200)
    expect(heartbeatMock.mock.calls[0][1]).toBe("shop")
  })

  it("still answers 200 when the heartbeat write fails (the phone must not retry-storm)", async () => {
    heartbeatMock.mockRejectedValue(new Error("db down 0241234567"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(JSON.stringify(spy.mock.calls)).not.toContain("0241234567")
    spy.mockRestore()
  })
})
