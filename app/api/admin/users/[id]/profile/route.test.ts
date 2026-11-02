import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { createFakeDb, USER_ID, type FakeDb, type GateMode } from "@/lib/admin-users/test-fake-db"

const h = vi.hoisted(() => ({ gate: "admin" as GateMode, fake: null as unknown as FakeDb }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => (await import("@/lib/admin-users/test-fake-db")).fakeVerify(h.gate)),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => new Proxy({}, { get: (_t, k) => (h.fake.db as any)[k] }) }))

import { GET as RAW_GET } from "./route"

const GET = async (id = USER_ID) =>
  (await RAW_GET(new NextRequest(`http://x/api/admin/users/${id}/profile`), { params: Promise.resolve({ id }) }))!

const PROFILE = {
  id: USER_ID, email: "old@x.com", phone_number: "0244000000", first_name: "Ama", last_name: "M", role: "dealer",
  is_suspended: true, pricing_mode: "custom", phone_verified: true, phone_verify_deadline: null, created_at: "2026-01-01",
}
const fake = (o: { profile?: unknown; auth?: unknown; suspension?: unknown } = {}) =>
  createFakeDb({
    tables: {
      users: () => ({ data: o.profile === undefined ? PROFILE : o.profile, error: null }),
      wallets: () => ({ data: { balance: "12.50" }, error: null }),
      admin_audit_log: () => ({ data: o.suspension === undefined ? { new_value: { reason: "chargebacks" }, created_at: "2026-10-01" } : o.suspension, error: null }),
    },
    getUserById: () => o.auth === null
      ? { data: { user: null }, error: { message: "User not found" } }
      : { data: { user: { id: USER_ID, email: "new@x.com", created_at: "2025-12-31", last_sign_in_at: "2026-10-30", email_confirmed_at: "2026-01-01" } }, error: null },
  })

beforeEach(() => {
  h.gate = "admin"
  h.fake = fake()
})

describe("GET /api/admin/users/[id]/profile", () => {
  it("gates on verifyAdminAccess", async () => {
    h.gate = "forbidden"
    expect((await GET()).status).toBe(403)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("400s on a bad uuid", async () => {
    expect((await GET("not-a-uuid")).status).toBe(400)
    expect(h.fake.queries).toHaveLength(0)
  })

  it("merges profile, auth user, wallet and the latest suspension reason", async () => {
    const body = await (await GET()).json()
    expect(body).toEqual({
      id: USER_ID, email: "new@x.com", phoneNumber: "0244000000", firstName: "Ama", lastName: "M", role: "dealer",
      pricingMode: "custom", isSuspended: true, suspension: { reason: "chargebacks", at: "2026-10-01" },
      phoneVerified: true, phoneVerifyDeadline: null, createdAt: "2025-12-31", lastSignInAt: "2026-10-30",
      emailConfirmedAt: "2026-01-01", hasProfile: true, walletBalance: 12.5,
    })
    const audit = h.fake.ofTable("admin_audit_log")[0]
    expect(audit.op("eq")).toEqual(["eq", "target_user_id", USER_ID])
    expect(audit.ops).toContainEqual(["eq", "action", "user_suspend"])
    expect(audit.ops).toContainEqual(["limit", 1])
  })

  it("no suspension info for a user who is not suspended", async () => {
    h.fake = fake({ profile: { ...PROFILE, is_suspended: false } })
    expect((await (await GET()).json()).suspension).toBeNull()
  })

  it("404 when neither a profile nor an auth user exists; auth-only users still load", async () => {
    h.fake = fake({ profile: null, auth: null })
    expect((await GET()).status).toBe(404)
    h.fake = fake({ profile: null })
    const body = await (await GET()).json()
    expect(body.hasProfile).toBe(false)
    expect(body.role).toBe("user")
  })
})
