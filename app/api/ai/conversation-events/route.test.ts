import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ allowed: true, flag: vi.fn(async (..._a: any[]) => true) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: vi.fn(async () => ({ allowed: h.allowed, remaining: 1, resetAt: 0 })) }))
vi.mock("@/lib/ai-console/transcripts", () => ({ flagConversation: (...a: any[]) => h.flag(...a) }))

import { POST } from "./route"

const K = "11111111-1111-4111-8111-111111111111"
const post = (body: unknown, raw = false) =>
  POST(new NextRequest("http://localhost/api/ai/conversation-events", { method: "POST", body: raw ? (body as string) : JSON.stringify(body) }))

beforeEach(() => { vi.clearAllMocks(); h.allowed = true; h.flag = vi.fn(async () => true) })

describe("conversation-events route", () => {
  it("events_route_flags_existing_only", async () => {
    const r = await post({ conversationKey: K, event: "handoff" })
    expect(r.status).toBe(204)
    expect(h.flag).toHaveBeenCalledWith(expect.anything(), K, "handoff")
    // unknown conversation: still 204; flagConversation never creates (it returns false)
    h.flag = vi.fn(async () => false)
    expect((await post({ conversationKey: K, event: "error" })).status).toBe(204)
  })

  it("events_route_validates", async () => {
    expect((await post("not json", true)).status).toBe(400)
    expect((await post({ conversationKey: "nope", event: "handoff" })).status).toBe(400)
    expect((await post({ conversationKey: K, event: "card_failed" })).status).toBe(400)
    expect((await post({ conversationKey: K })).status).toBe(400)
    expect(h.flag).not.toHaveBeenCalled()
  })

  it("is rate limited", async () => {
    h.allowed = false
    expect((await post({ conversationKey: K, event: "error" })).status).toBe(429)
    expect(h.flag).not.toHaveBeenCalled()
  })
})
