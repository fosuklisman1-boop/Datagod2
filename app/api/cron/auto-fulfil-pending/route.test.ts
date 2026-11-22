import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({ authorized: true }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: vi.fn(() =>
    h.authorized ? { authorized: true } : { authorized: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
  ),
}))
vi.mock("@/lib/auto-fulfil/run", () => ({ runAutoFulfil: vi.fn() }))

import { GET, maxDuration } from "./route"
import { runAutoFulfil } from "@/lib/auto-fulfil/run"

const SUMMARY = { ran: true, runId: "r1", queued: 2, waiting: 1, needsYou: 0, skipped: { blacklisted: 1 }, cancelled: 0 }

beforeEach(() => {
  vi.mocked(runAutoFulfil).mockReset()
  h.authorized = true
})

describe("GET /api/cron/auto-fulfil-pending", () => {
  it("route rejects requests without cron auth", async () => {
    h.authorized = false
    const r = await GET(new NextRequest("http://localhost/api/cron/auto-fulfil-pending"))
    expect(r.status).toBe(401)
    expect(runAutoFulfil).not.toHaveBeenCalled()
  })

  it("returns the run summary", async () => {
    vi.mocked(runAutoFulfil).mockResolvedValue(SUMMARY as any)
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      const r = await GET(new NextRequest("http://localhost/api/cron/auto-fulfil-pending"))
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual(SUMMARY)
    } finally {
      log.mockRestore()
    }
  })

  it("candidate RPC error (run throws) => 500", async () => {
    vi.mocked(runAutoFulfil).mockRejectedValue(new Error("auto-fulfil: candidates read failed: statement timeout"))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const r = await GET(new NextRequest("http://localhost/api/cron/auto-fulfil-pending"))
      expect(r.status).toBe(500)
      expect(await r.json()).toEqual({ error: "Internal server error" })
    } finally {
      err.mockRestore()
    }
  })

  it("has a 60 s limit", () => {
    expect(maxDuration).toBe(60)
  })
})
