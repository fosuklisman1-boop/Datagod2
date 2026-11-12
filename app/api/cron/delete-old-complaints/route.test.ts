import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({ authorized: true }))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: vi.fn(() =>
    h.authorized ? { authorized: true } : { authorized: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
  ),
}))
vi.mock("@/lib/support-cleanup", () => ({
  deleteOldSupportData: vi.fn(async () => ({ closedThreads: 2, legacyComplaints: 3, filesRemoved: 4, errors: 0 })),
}))

import { GET } from "./route"
import { deleteOldSupportData } from "@/lib/support-cleanup"

const get = (qs = "") => GET(new NextRequest(`http://localhost/api/cron/delete-old-complaints${qs}`))

beforeEach(() => {
  vi.clearAllMocks()
  h.authorized = true
})

describe("GET /api/cron/delete-old-complaints", () => {
  it("rejects an unauthorised caller without running the cleanup", async () => {
    h.authorized = false
    expect((await get()).status).toBe(401)
    expect(deleteOldSupportData).not.toHaveBeenCalled()
  })

  it("runs for real by default and returns the counts", async () => {
    const body = await (await get()).json()
    expect(vi.mocked(deleteOldSupportData).mock.calls[0][2]).toEqual({ dryRun: false })
    expect(body).toEqual({ success: true, data: { dryRun: false, closedThreads: 2, legacyComplaints: 3, filesRemoved: 4, errors: 0 } })
  })

  it("?dry=1 is a dry run", async () => {
    const body = await (await get("?dry=1")).json()
    expect(vi.mocked(deleteOldSupportData).mock.calls[0][2]).toEqual({ dryRun: true })
    expect(body.data.dryRun).toBe(true)
  })

  it.each(["?dry=true", "?dry=yes", "?dry=", "?dry=1", "?dry=TRUE", "?dry=00"])("%s is a dry run (fail-safe)", async (qs) => {
    await get(qs)
    expect(vi.mocked(deleteOldSupportData).mock.calls[0][2]).toEqual({ dryRun: true })
  })

  it.each(["", "?dry=0", "?dry=false", "?dry=FALSE"])("'%s' runs for real", async (qs) => {
    await get(qs)
    expect(vi.mocked(deleteOldSupportData).mock.calls[0][2]).toEqual({ dryRun: false })
  })

  it("500 generic when the cleanup throws", async () => {
    vi.mocked(deleteOldSupportData).mockRejectedValueOnce(new Error("secret detail"))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
})
