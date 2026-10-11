import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  batched: vi.fn(),
  dbCalls: [] as string[],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "u1" } }, error: null }) },
    from: (t: string) => { h.dbCalls.push(t); throw new Error("unexpected DB access") },
    rpc: (fn: string) => { h.dbCalls.push(fn); throw new Error("unexpected RPC") },
  }),
}))
vi.mock("@/lib/sms/account-service", () => ({
  getOrCreateAccountForUser: () => Promise.resolve({ id: "acc1", default_sender_id: null }),
}))
vi.mock("@/lib/sms/send-service", () => ({ enqueueSendBatched: h.batched, SMS_MAX_TOTAL: 5000 }))
vi.mock("@/lib/sms/shop-context-service", () => ({
  getShopTokens: () => Promise.resolve({ shop_name: "", shop_link: "", shop_phone: "", shop_whatsapp: "" }),
}))
vi.mock("@/lib/sms/default-sender", () => ({ loadDefaultSender: () => Promise.resolve(null) }))
vi.mock("@/lib/sms/tenant-address-book-service", () => ({ getGroupActiveRecipients: vi.fn() }))

import { POST } from "./route"

const OK = {
  ok: true, batches: 1, totalQueued: 1, segments: 1, creditsReserved: 1, invalidSkipped: 0,
  partial: false, held: false, scheduled: false, scheduledFor: null, sendLogId: "9",
}

function call(body: unknown) {
  return POST(new NextRequest("http://localhost/api/shop/sms/send", {
    method: "POST",
    headers: { authorization: "Bearer t" },
    body: JSON.stringify(body),
  }))
}
const future = (ms: number) => new Date(Date.now() + ms).toISOString()

beforeEach(() => {
  h.batched.mockReset()
  h.batched.mockResolvedValue(OK)
  h.dbCalls.length = 0
})

describe("POST /api/shop/sms/send scheduledAt", () => {
  it("omitted → unchanged call (no opts arg), scheduled:false in data", async () => {
    const res = await call({ message: "Hello world", recipients: ["0241234567"] })
    expect(res.status).toBe(200)
    expect(h.batched.mock.calls[0]).toHaveLength(6)
    const j = await res.json()
    expect(j.data).toMatchObject({ scheduled: false, scheduledFor: null, held: false, sendLogId: "9" })
  })

  it("null → treated as send-now", async () => {
    await call({ message: "Hello world", recipients: ["0241234567"], scheduledAt: null })
    expect(h.batched.mock.calls[0]).toHaveLength(6)
  })

  it.each([
    ["too soon", () => future(30_000), "Pick a time at least 2 minutes from now"],
    ["too far", () => future(31 * 24 * 3_600_000), "You can schedule up to 30 days ahead"],
    ["no offset", () => "2030-01-01T10:00:00", undefined],
    ["number", () => Date.now() + 3_600_000, undefined],
    ["garbage", () => "tomorrow", undefined],
  ])("invalid (%s) → 400 INVALID_SCHEDULE, nothing enqueued or read", async (_n, at, msg) => {
    const res = await call({ message: "Hello world", recipients: ["0241234567"], scheduledAt: at() })
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j).toMatchObject({ success: false, error: "INVALID_SCHEDULE" })
    expect(typeof j.message).toBe("string")
    if (msg) expect(j.message).toBe(msg)
    expect(h.batched).not.toHaveBeenCalled()
    expect(h.dbCalls).toEqual([])
  })

  it("valid → passes { scheduledFor: Date } and returns scheduled + scheduledFor", async () => {
    const at = future(3 * 3_600_000)
    h.batched.mockResolvedValue({ ...OK, scheduled: true, scheduledFor: at })
    const res = await call({ message: "Hello world", recipients: ["0241234567"], scheduledAt: at })
    expect(res.status).toBe(200)
    const args = h.batched.mock.calls[0]
    expect(args[6]).toEqual({ scheduledFor: new Date(at) })
    const j = await res.json()
    expect(j.data).toMatchObject({ scheduled: true, scheduledFor: at, held: false })
  })
})
