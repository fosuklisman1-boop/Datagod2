import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  batched: vi.fn(),
  env: "live" as "live" | "test",
}))

// Every read resolves to "no row" (no rate-limit override, no default/active sender).
vi.mock("@supabase/supabase-js", () => {
  const chain: any = new Proxy({}, {
    get: (_t, k) => (k === "then" ? undefined : k === "maybeSingle" ? () => Promise.resolve({ data: null, error: null }) : () => chain),
  })
  return { createClient: () => ({ from: () => chain }) }
})
vi.mock("@/lib/api-auth", () => ({
  authenticateApiKey: () => Promise.resolve({ id: "u1", api_key_id: "k1", environment: h.env }),
  logApiRequest: () => Promise.resolve(),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: () => Promise.resolve({ allowed: true }) }))
vi.mock("@/lib/sms/platform-settings", () => ({
  loadSmsSettings: () => Promise.resolve({ apiRateLimitDefault: 60 }),
  apiRateLimitFor: () => 60,
}))
vi.mock("@/lib/sms/account-service", () => ({
  getOrCreateAccountForUser: () => Promise.resolve({ id: "acc1", default_sender_id: null }),
}))
vi.mock("@/lib/sms/send-service", () => ({ enqueueSendBatched: h.batched, SMS_MAX_TOTAL: 5000 }))
vi.mock("@/lib/sms/shop-context-service", () => ({
  getShopTokens: () => Promise.resolve({ shop_name: "", shop_link: "", shop_phone: "", shop_whatsapp: "" }),
}))

import { POST } from "./route"

const OK = {
  ok: true, batches: 1, totalQueued: 1, segments: 1, creditsReserved: 1, invalidSkipped: 0,
  partial: false, held: false, scheduled: false, scheduledFor: null, sendLogId: "9",
}
const call = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/v1/sms/send", { method: "POST", body: JSON.stringify(body) }))
const future = (ms: number) => new Date(Date.now() + ms).toISOString()

beforeEach(() => {
  h.batched.mockReset()
  h.batched.mockResolvedValue(OK)
  h.env = "live"
})

describe("POST /api/v1/sms/send scheduled_at", () => {
  it("omitted → unchanged call, status queued, scheduled:false", async () => {
    const res = await call({ message: "Hello world", recipients: ["0241234567"] })
    expect(res.status).toBe(200)
    expect(h.batched.mock.calls[0]).toHaveLength(6)
    expect(await res.json()).toMatchObject({ status: "queued", scheduled: false, scheduled_for: null, held: false })
  })

  it("invalid → 400 INVALID_SCHEDULE with the bounds message, nothing enqueued", async () => {
    for (const [at, msg] of [
      [future(60_000), "Pick a time at least 2 minutes from now"],
      [future(31 * 24 * 3_600_000), "You can schedule up to 30 days ahead"],
      ["2030-01-01 10:00", undefined],
      [12345, undefined],
    ] as const) {
      const res = await call({ message: "Hello world", recipients: ["0241234567"], scheduled_at: at })
      expect(res.status).toBe(400)
      const j = await res.json()
      expect(j).toMatchObject({ success: false, error: "INVALID_SCHEDULE" })
      if (msg) expect(j.message).toBe(msg)
    }
    expect(h.batched).not.toHaveBeenCalled()
  })

  it("valid → { scheduledFor } passed; status 'scheduled', scheduled_for in the body", async () => {
    const at = future(2 * 3_600_000)
    h.batched.mockResolvedValue({ ...OK, scheduled: true, scheduledFor: at })
    const res = await call({ message: "Hello world", recipients: ["0241234567"], scheduled_at: at })
    expect(res.status).toBe(200)
    expect(h.batched.mock.calls[0][6]).toEqual({ scheduledFor: new Date(at) })
    expect(await res.json()).toMatchObject({ success: true, status: "scheduled", scheduled: true, scheduled_for: at })
  })

  it("held wins over scheduled in the status", async () => {
    h.batched.mockResolvedValue({ ...OK, held: true })
    const res = await call({ message: "Hello world", recipients: ["0241234567"], scheduled_at: future(3_600_000) })
    expect(await res.json()).toMatchObject({ status: "held", held: true, scheduled: false })
  })

  it("sandbox body carries scheduled:false (still validates scheduled_at)", async () => {
    h.env = "test"
    const res = await call({ message: "Hello world", recipients: ["0241234567"] })
    expect(await res.json()).toMatchObject({ sandbox: true, scheduled: false, scheduled_for: null })
    const bad = await call({ message: "Hello world", recipients: ["0241234567"], scheduled_at: "nope" })
    expect(bad.status).toBe(400)
    expect(h.batched).not.toHaveBeenCalled()
  })

  it("sandbox echoes a valid scheduled_at (status 'scheduled', scheduled_for ISO), still no enqueue", async () => {
    h.env = "test"
    const at = new Date(Date.now() + 3_600_000)
    const res = await call({ message: "Hello world", recipients: ["0241234567"], scheduled_at: at.toISOString().replace("Z", "+00:00") })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      sandbox: true, status: "scheduled", scheduled: true, scheduled_for: at.toISOString(), held: false, send_log_id: null,
    })
    expect(h.batched).not.toHaveBeenCalled()
  })
})
