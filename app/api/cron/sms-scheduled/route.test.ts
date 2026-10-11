import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  authorized: true,
  run: vi.fn(),
}))
vi.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: () => h.authorized
    ? { authorized: true }
    : { authorized: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
}))
vi.mock("@/lib/sms/scheduled-service", () => ({ runScheduledDispatch: h.run }))

import { GET, maxDuration } from "./route"

const req = () => new NextRequest("http://localhost/api/cron/sms-scheduled")

beforeEach(() => {
  h.authorized = true
  h.run.mockReset()
})

describe("GET /api/cron/sms-scheduled", () => {
  it("requires the cron secret", async () => {
    h.authorized = false
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(h.run).not.toHaveBeenCalled()
  })

  it("runs the dispatcher with a ~100 s deadline and returns the summary", async () => {
    const summary = { promoted: 2, dispatched: 2, placed: 7, cancelled: 1, deferred: 0, errors: 0 }
    h.run.mockResolvedValue(summary)
    const before = Date.now()
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: summary })
    const opts = h.run.mock.calls[0][0]
    expect(opts.deadlineMs - before).toBeGreaterThanOrEqual(95_000)
    expect(opts.deadlineMs - before).toBeLessThanOrEqual(105_000)
    expect(opts.hardDeadlineMs).toBeGreaterThan(opts.deadlineMs)
    expect(opts.hardDeadlineMs - before).toBeLessThan(maxDuration * 1000)
  })

  it("kill switch off → 200 with skipped", async () => {
    h.run.mockResolvedValue({ skipped: "sms_disabled" })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { skipped: "sms_disabled" } })
  })

  it("per-log errors → 500 with the summary (visible in cron monitoring)", async () => {
    const summary = { promoted: 2, dispatched: 1, placed: 1, cancelled: 0, deferred: 0, errors: 1 }
    h.run.mockResolvedValue(summary)
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, data: summary })
  })

  it("a throw → 500", async () => {
    h.run.mockRejectedValue(new Error("boom"))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: "boom" })
  })

  it("maxDuration is 300", () => {
    expect(maxDuration).toBe(300)
  })
})

describe("vercel.json", () => {
  it("parses and schedules the cron every minute", () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"))
    expect(cfg.crons).toContainEqual({ path: "/api/cron/sms-scheduled", schedule: "* * * * *" })
  })
})
