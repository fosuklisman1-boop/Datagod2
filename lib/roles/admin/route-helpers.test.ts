import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"
import { reqOf, ADMIN } from "@/app/api/admin/roles/test-utils"

const h = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: h.verify }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ marker: "db" }) }))

import { requireHubAdmin, mapRpcError } from "./route-helpers"

beforeEach(() => h.verify.mockReset())

describe("requireHubAdmin", () => {
  it("passes through the auth error response (401/403)", async () => {
    h.verify.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    const r = await requireHubAdmin(reqOf("GET"))
    expect("response" in r && r.response.status).toBe(401)
  })
  it("403 when not admin without an error response", async () => {
    h.verify.mockResolvedValue({ isAdmin: false })
    const r = await requireHubAdmin(reqOf("GET"))
    expect("response" in r && r.response.status).toBe(403)
  })
  it("403 Admin user required when the CRON bypass gives no userId", async () => {
    h.verify.mockResolvedValue({ isAdmin: true })
    const r = await requireHubAdmin(reqOf("GET"))
    expect("response" in r).toBe(true)
    if ("response" in r) {
      expect(r.response.status).toBe(403)
      expect(await r.response.json()).toEqual({ error: "Admin user required" })
    }
  })
  it("returns the admin id and a db client for a real admin", async () => {
    h.verify.mockResolvedValue({ isAdmin: true, userId: ADMIN })
    const r = await requireHubAdmin(reqOf("GET"))
    expect("adminId" in r && r.adminId).toBe(ADMIN)
  })
})

describe("mapRpcError", () => {
  it("members -> 409, rank in use -> 409, validation -> 400, unknown -> 500 without detail", async () => {
    expect(mapRpcError({ message: "role has members" }, 3).status).toBe(409)
    expect(mapRpcError({ message: "rank 5 is already in use" }).status).toBe(409)
    expect(mapRpcError({ message: "slug is reserved for a system role" }).status).toBe(400)
    const r = mapRpcError({ message: 'relation "secret_table" does not exist' })
    expect(r.status).toBe(500)
    expect(JSON.stringify(await r.json())).not.toContain("secret_table")
  })
})
