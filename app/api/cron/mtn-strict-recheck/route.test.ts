import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({ authorized: true }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: vi.fn(() =>
    h.authorized ? { authorized: true } : { authorized: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
  ),
}))
vi.mock("@/lib/strict-verify/recheck", () => ({ runStrictRecheck: vi.fn() }))

import { GET, maxDuration } from "./route"
import { runStrictRecheck } from "@/lib/strict-verify/recheck"

beforeEach(() => {
  vi.mocked(runStrictRecheck).mockReset()
  h.authorized = true
})

describe("GET /api/cron/mtn-strict-recheck", () => {
  it("route rejects requests without cron auth", async () => {
    h.authorized = false
    const r = await GET(new NextRequest("http://localhost/api/cron/mtn-strict-recheck"))
    expect(r.status).toBe(401)
    expect(runStrictRecheck).not.toHaveBeenCalled()
  })

  it("has the 300 s budget", () => {
    expect(maxDuration).toBe(300)
  })

  it("is listed in crons.json every 5 minutes as a fulfillment-class (batch C) job", async () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "lib/cron-migration/crons.json"), "utf8"))
    expect(cfg.crons).toContainEqual({ path: "/api/cron/mtn-strict-recheck", schedule: "*/5 * * * *" })
    const { buildJobSpecs } = await import("@/lib/cron-migration/jobs")
    const spec = buildJobSpecs(cfg.crons, "https://example.test").find((s) => s.path === "/api/cron/mtn-strict-recheck")!
    expect(spec.batch).toBe("C")
    expect(spec.fulfillment).toBe(true)
  })
})
