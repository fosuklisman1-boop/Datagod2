import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({ authorized: true }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: vi.fn(() => (h.authorized ? { authorized: true } : { authorized: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })),
}))
vi.mock("@/lib/ai-console/retention", () => ({ deleteOldConversations: vi.fn(async () => 7) }))

import { GET } from "./route"
import { deleteOldConversations } from "@/lib/ai-console/retention"

beforeEach(() => { vi.clearAllMocks(); h.authorized = true })

describe("GET /api/cron/ai-conversations-retention", () => {
  it("rejects unauthorised callers", async () => {
    h.authorized = false
    expect((await GET(new NextRequest("http://localhost/x"))).status).toBe(401)
    expect(deleteOldConversations).not.toHaveBeenCalled()
  })
  it("runs and returns the count", async () => {
    const r = await GET(new NextRequest("http://localhost/x"))
    expect(await r.json()).toEqual({ success: true, data: { deleted: 7 } })
  })
})
