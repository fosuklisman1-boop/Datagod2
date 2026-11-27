import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: (...a: unknown[]) => h.rpc(...a) }) }))

import { POST } from "./route"

const req = (body: unknown) => new NextRequest("http://localhost/api/auth/check-phone", { method: "POST", body: JSON.stringify(body) })
const row = (match_count: number, user_id: string | null) => ({
  data: [{ match_count, verified_count: 0, user_id, email: null, phone_number: null, phone_verified: null, is_suspended: null }],
  error: null,
})

beforeEach(() => h.rpc.mockReset())

describe("POST /api/auth/check-phone", () => {
  it("reports 0241234567 as taken when stored in another form (normalised sig lookup)", async () => {
    h.rpc.mockResolvedValue(row(1, "u1"))
    const res = await POST(req({ phoneNumber: "0241234567" }))
    expect(h.rpc).toHaveBeenCalledWith("phone_login_find_account", { p_sig: "241234567" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false, error: "This phone number is already registered" })
  })
  it("available when no match", async () => {
    h.rpc.mockResolvedValue(row(0, null))
    const res = await POST(req({ phoneNumber: "0241234567" }))
    expect(await res.json()).toEqual({ available: true, message: "Phone number is available" })
  })
  it("excludeUserId: own account is not taken, another is, ambiguous is", async () => {
    h.rpc.mockResolvedValueOnce(row(1, "me"))
    expect((await (await POST(req({ phoneNumber: "0241234567", excludeUserId: "me" }))).json()).available).toBe(true)
    h.rpc.mockResolvedValueOnce(row(1, "other"))
    expect((await (await POST(req({ phoneNumber: "0241234567", excludeUserId: "me" }))).json()).available).toBe(false)
    h.rpc.mockResolvedValueOnce(row(2, null))
    expect((await (await POST(req({ phoneNumber: "0241234567", excludeUserId: "me" }))).json()).available).toBe(false)
  })
  it("keeps existing 400s for missing / wrong-length numbers", async () => {
    expect((await POST(req({}))).status).toBe(400)
    const r = await POST(req({ phoneNumber: "12345" }))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: "Phone number must be 9 or 10 digits" })
  })
  it("a 9-10 digit string that is not a Ghana mobile keeps the invalid response", async () => {
    const r = await POST(req({ phoneNumber: "1234567890" }))
    expect(r.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it("rpc error -> 500", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "x" } })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect((await POST(req({ phoneNumber: "0241234567" }))).status).toBe(500)
    spy.mockRestore()
  })
})
