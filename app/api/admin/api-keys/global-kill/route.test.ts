import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

const h = vi.hoisted(() => ({ admin: true, recs: [] as any[], auditOk: true }))

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () =>
    h.admin
      ? { isAdmin: true, userId: (globalThis as any).__noAdminId ? undefined : "admin-1", errorResponse: null }
      : { isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) },
}))
vi.mock("@/lib/api-v2/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/store")>("@/lib/api-v2/store")
  return { ...actual, revokeAllV2Keys: async () => 3, disableV2: async () => {} }
})
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      const rec: any = { table, op: "select" }
      h.recs.push(rec)
      const result = () => (table === "admin_audit_log" ? { data: null, error: h.auditOk ? null : { message: "x" } } : { data: null, error: null })
      const b: any = {
        update(p: any) { rec.op = "update"; rec.payload = p; return b },
        insert(p: any) { rec.op = "insert"; rec.payload = p; return b },
        neq() { return b },
        then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej) },
      }
      return b
    },
  }),
}))

import { POST } from "./route"

const audits = () => h.recs.filter((r) => r.table === "admin_audit_log" && r.op === "insert")

beforeEach(() => {
  h.admin = true
  h.recs.length = 0
  h.auditOk = true
})

describe("POST /api/admin/api-keys/global-kill", () => {
  it("non-admins are refused before anything is touched", async () => {
    h.admin = false
    expect((await POST({ headers: new Headers() } as any))!.status).toBe(403)
    expect(h.recs).toHaveLength(0)
  })
  it("writes one api_global_kill audit row with the verified admin and the outcome", async () => {
    const res = (await POST({ headers: new Headers() } as any))!
    expect(res.status).toBe(200)
    expect(audits()).toHaveLength(1)
    expect(audits()[0].payload).toMatchObject({ admin_id: "admin-1", action: "api_global_kill", new_value: { v1Disabled: true, v2Revoked: 3, v2Disabled: true } })
  })
  it("the cron secret (admin with no user id) cannot run the kill: 403, nothing touched", async () => {
    ;(globalThis as any).__noAdminId = true
    try {
      expect((await POST({ headers: new Headers() } as any))!.status).toBe(403)
      expect(h.recs).toHaveLength(0)
    } finally {
      ;(globalThis as any).__noAdminId = false
    }
  })
  it("an audit failure keeps the kill and reports auditFailed", async () => {
    h.auditOk = false
    const res = (await POST({ headers: new Headers() } as any))!
    expect(res.status).toBe(200)
    expect((await res.json()).auditFailed).toBe(true)
  })
})
