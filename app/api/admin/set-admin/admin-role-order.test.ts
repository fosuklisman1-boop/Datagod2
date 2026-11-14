import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// Migration 0179 pins auth user_metadata.role to public.users.role on every metadata write, so the
// admin grant/revoke routes MUST write public.users first. Metadata-first is reverted by the trigger
// (and raises a metadata_tamper alert). A failed users write must fail the request, not half-grant.

const USER_ID = "11111111-1111-1111-1111-111111111111"
const h = vi.hoisted(() => ({ calls: [] as string[], usersError: null as null | { message: string } }))

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "admin-1" } }, error: null }),
      admin: {
        updateUserById: async (_id: string, attrs: { user_metadata: { role: string } }) => {
          h.calls.push(`metadata:${attrs.user_metadata.role}`)
          return { data: { user: { id: USER_ID } }, error: null }
        },
        listUsers: async () => ({ data: { users: [{ id: USER_ID, email: "x@ok.com" }] }, error: null }),
      },
    },
    from: (table: string) => ({
      // caller role check (set-admin-by-email)
      select: () => ({ eq: () => ({ single: async () => ({ data: { role: "admin" }, error: null }) }) }),
      update: (row: { role: string }) => ({
        eq: () => ({
          select: async () => {
            h.calls.push(`${table}:${row.role}`)
            return { data: h.usersError ? null : [{ id: USER_ID }], error: h.usersError }
          },
        }),
      }),
      insert: () => ({ then: (cb: (r: { error: null }) => void) => cb({ error: null }) }),
    }),
  }),
}))

import { POST as setAdmin } from "./route"
import { POST as setAdminByEmail } from "../set-admin-by-email/route"
import { POST as removeAdmin } from "../remove-admin/route"

const req = (body: unknown) =>
  new NextRequest("http://x/api/admin/route", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const cases = [
  ["set-admin", () => setAdmin(req({ userId: USER_ID })), "admin"],
  ["set-admin-by-email", () => setAdminByEmail(req({ email: "x@ok.com" })), "admin"],
  ["remove-admin", () => removeAdmin(req({ userId: USER_ID })), "user"],
] as const

describe("admin grant/revoke write order", () => {
  beforeEach(() => {
    h.calls = []
    h.usersError = null
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  for (const [name, call, role] of cases) {
    it(`${name}: writes public.users before auth metadata`, async () => {
      const res = await call()
      expect(res.status).toBe(200)
      expect(h.calls).toEqual([`users:${role}`, `metadata:${role}`])
    })

    it(`${name}: a failed users write fails the request and leaves metadata alone`, async () => {
      h.usersError = { message: "boom" }
      const res = await call()
      expect(res.status).toBe(500)
      expect(h.calls).toEqual([`users:${role}`])
    })
  }
})
