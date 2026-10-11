import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ auth: { isAdmin: true, userId: "admin-1" } as any }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: () => Promise.resolve(h.auth),
}))

import { adminGuard } from "./admin-guard"

const req = () => new NextRequest("http://localhost/api/x")
beforeEach(() => { h.auth = { isAdmin: true, userId: "admin-1" } })

describe("adminGuard", () => {
  it("passes an admin read and returns the admin id", async () => {
    expect(await adminGuard(req())).toEqual({ ok: true, adminId: "admin-1" })
  })
  it("passes a cron-secret read (no userId) with adminId null", async () => {
    h.auth = { isAdmin: true }
    expect(await adminGuard(req())).toEqual({ ok: true, adminId: null })
  })
  it("refuses a write without a real admin user (403)", async () => {
    h.auth = { isAdmin: true }
    const r = await adminGuard(req(), { write: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(403)
  })
  it("allows a write with a real admin user", async () => {
    expect(await adminGuard(req(), { write: true })).toEqual({ ok: true, adminId: "admin-1" })
  })
  it("honours the admin rate limit (isAdmin true + 429 errorResponse)", async () => {
    const { NextResponse } = await import("next/server")
    h.auth = { isAdmin: true, userId: "a", errorResponse: NextResponse.json({ error: "slow down" }, { status: 429 }) }
    const r = await adminGuard(req())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(429)
  })
  it("returns the auth error response for non-admins", async () => {
    const { NextResponse } = await import("next/server")
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
    const r = await adminGuard(req())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(401)
  })
})
