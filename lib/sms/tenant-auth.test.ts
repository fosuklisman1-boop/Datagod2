import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  getOrCreate: vi.fn(),
  cap: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", email: "a@b.c" } }, error: null }) } }),
}))
vi.mock("@/lib/sms/account-service", () => ({ getOrCreateAccountForUser: (...a: unknown[]) => h.getOrCreate(...a) }))
vi.mock("@/lib/roles/require-capability", () => ({ requireCapability: (...a: unknown[]) => h.cap(...a) }))

import { resolveAccount } from "./tenant-auth"

const req = () => new NextRequest("http://localhost/api/sms/contacts", { headers: { authorization: "Bearer t" } })

beforeEach(() => {
  h.getOrCreate.mockReset().mockResolvedValue({ id: "acc1" })
  h.cap.mockReset().mockResolvedValue(null)
})

describe("tenant SMS resolveAccount rights gate", () => {
  it("403 when the role lacks shop.sms, before the SMS account is read or created", async () => {
    h.cap.mockResolvedValueOnce(new Response(JSON.stringify({ error: "This feature isn't available for your account." }), { status: 403 }))
    const r = await resolveAccount(req())
    expect(r.error?.status).toBe(403)
    expect(h.cap).toHaveBeenCalledWith(expect.anything(), "u1", "shop.sms")
    expect(h.getOrCreate).not.toHaveBeenCalled()
  })

  it("allowed: resolves the account as before", async () => {
    const r = await resolveAccount(req())
    expect(r.error).toBeUndefined()
    expect(r.account).toEqual({ id: "acc1" })
  })
})
