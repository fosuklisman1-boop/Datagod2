import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })) }))

const upsert = vi.fn(async (_rows: unknown, _opts: unknown) => ({ error: null as unknown }))
const del = vi.fn(async (_c: string, _keys: string[]) => ({ error: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: (rows: unknown, opts: unknown) => upsert(rows, opts),
      delete: () => ({ in: (c: string, keys: string[]) => del(c, keys) }),
    }),
  },
}))

import { POST, DELETE } from "./route"

const req = (method: string, body: unknown) =>
  new NextRequest("http://x/api/admin/sms-opt-outs", { method, body: JSON.stringify(body) })

describe("POST /api/admin/sms-opt-outs", () => {
  beforeEach(() => vi.clearAllMocks())

  it("accepts a pasted list in any format, dedupes by last 9 digits and reports invalid entries", async () => {
    const res = await POST(req("POST", { phones: "0241234567, +233 24 123 4567\n233201112222 abc 12345", reason: "asked to stop" }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ added: 2, invalid: ["abc", "12345"] })
    const rows = upsert.mock.calls[0][0] as Array<{ phone_key: string; reason: string; added_by: string }>
    expect(rows.map((r) => r.phone_key).sort()).toEqual(["201112222", "241234567"])
    expect(rows[0]).toMatchObject({ reason: "asked to stop", added_by: "admin-1" })
  })

  it("400 when nothing valid is given", async () => {
    const res = await POST(req("POST", { phones: ["abc"] }))
    expect(res.status).toBe(400)
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/admin/sms-opt-outs", () => {
  it("removes by phone key", async () => {
    const res = await DELETE(req("DELETE", { phones: ["0241234567"] }))
    expect(res.status).toBe(200)
    expect(del).toHaveBeenCalledWith("phone_key", ["241234567"])
  })
})
