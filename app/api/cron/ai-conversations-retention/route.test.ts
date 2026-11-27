import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({ authorized: true }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: vi.fn(() => (h.authorized ? { authorized: true } : { authorized: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })),
}))
vi.mock("@/lib/ai-console/retention", () => ({
  deleteOldConversations: vi.fn(async () => 7),
  deleteOldVoiceCalls: vi.fn(async () => 3),
  deleteOldVoiceQueue: vi.fn(async () => 2),
}))

import { GET } from "./route"
import { deleteOldConversations, deleteOldVoiceCalls, deleteOldVoiceQueue } from "@/lib/ai-console/retention"

beforeEach(() => { vi.clearAllMocks(); h.authorized = true })

describe("GET /api/cron/ai-conversations-retention", () => {
  it("rejects unauthorised callers", async () => {
    h.authorized = false
    expect((await GET(new NextRequest("http://localhost/x"))).status).toBe(401)
    expect(deleteOldConversations).not.toHaveBeenCalled()
    expect(deleteOldVoiceCalls).not.toHaveBeenCalled()
  })
  it("runs and returns the counts", async () => {
    const r = await GET(new NextRequest("http://localhost/x"))
    expect(await r.json()).toEqual({ success: true, data: { deleted: 7, voiceCallsDeleted: 3, voiceQueueDeleted: 2 } })
  })
  it("still runs the other jobs when waiting-line retention fails", async () => {
    vi.mocked(deleteOldVoiceQueue).mockRejectedValueOnce(new Error("boom"))
    const r = await GET(new NextRequest("http://localhost/x"))
    expect(deleteOldConversations).toHaveBeenCalledTimes(1)
    expect(deleteOldVoiceCalls).toHaveBeenCalledTimes(1)
    expect(r.status).toBe(500)
  })
  it("a failing earlier job does not stop waiting-line retention", async () => {
    vi.mocked(deleteOldVoiceCalls).mockRejectedValueOnce(new Error("boom"))
    await GET(new NextRequest("http://localhost/x"))
    expect(deleteOldVoiceQueue).toHaveBeenCalledTimes(1)
  })
  it("still runs conversation retention when voice-call retention fails", async () => {
    vi.mocked(deleteOldVoiceCalls).mockRejectedValueOnce(new Error("boom"))
    const r = await GET(new NextRequest("http://localhost/x"))
    expect(deleteOldConversations).toHaveBeenCalledTimes(1)
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ success: false, error: "Internal server error" })
  })
  it("still runs voice-call retention when conversation retention fails", async () => {
    vi.mocked(deleteOldConversations).mockRejectedValueOnce(new Error("boom"))
    const r = await GET(new NextRequest("http://localhost/x"))
    expect(deleteOldVoiceCalls).toHaveBeenCalledTimes(1)
    expect(r.status).toBe(500)
    expect(await r.json()).toEqual({ success: false, error: "Internal server error" })
  })
})
