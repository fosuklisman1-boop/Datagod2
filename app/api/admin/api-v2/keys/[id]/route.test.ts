import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  admin: true,
  recs: [] as any[],
  key: { id: "k1", status: "active", user_id: "u1" } as any,
  auditOk: true,
  decide: vi.fn(async (..._a: any[]): Promise<any> => ({ status: 200, body: { ok: true } })),
}))

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () =>
    h.admin
      ? { isAdmin: true, userId: (globalThis as any).__noAdminId ? undefined : "admin-1", errorResponse: null }
      : { isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) },
}))
vi.mock("@/lib/api-v2/approvals", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/approvals")>("@/lib/api-v2/approvals")
  return { ...actual, decide: (...a: any[]) => h.decide(...a) }
})
vi.mock("@/lib/api-v2/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/store")>("@/lib/api-v2/store")
  return {
    ...actual,
    getAdminClient: () => ({
      rpc: async () => ({ data: null, error: null }),
      from(table: string) {
        const rec: any = { table, op: "select" }
        h.recs.push(rec)
        const result = () => {
          if (table === "admin_audit_log") return { data: null, error: h.auditOk ? null : { message: "x" } }
          if (rec.op === "update") return { data: [{ ...h.key, ...rec.payload }], error: null }
          return { data: h.key, error: null }
        }
        const b: any = {
          select() { return b },
          insert(p: any) { rec.op = "insert"; rec.payload = p; return b },
          update(p: any) { rec.op = "update"; rec.payload = p; return b },
          eq() { return b },
          maybeSingle() { return Promise.resolve(result()) },
          then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej) },
        }
        return b
      },
    }),
  }
})

import { PATCH } from "./route"

const patch = async (body: any) => (await PATCH({ headers: new Headers(), json: async () => body } as any, { params: Promise.resolve({ id: "k1" }) }))!
const updates = () => h.recs.filter((r) => r.table === "api_v2_keys" && r.op === "update")
const audits = () => h.recs.filter((r) => r.table === "admin_audit_log" && r.op === "insert")

beforeEach(() => {
  h.admin = true
  h.recs.length = 0
  h.key = { id: "k1", status: "active", user_id: "u1" }
  h.auditOk = true
  h.decide.mockClear()
})

describe("PATCH /api/admin/api-v2/keys/[id]", () => {
  it("non-admins are refused before any read", async () => {
    h.admin = false
    expect((await patch({ action: "revoke" })).status).toBe(403)
    expect(h.recs).toHaveLength(0)
  })
  it("approve goes through the atomic function, never a direct status update", async () => {
    h.key = { id: "k1", status: "pending", user_id: "u1" }
    expect((await patch({ action: "approve" })).status).toBe(200)
    expect(h.decide.mock.calls[0][1]).toEqual({ kind: "key", action: "approve", id: "k1", actorId: "admin-1", reason: undefined })
    expect(updates()).toHaveLength(0)
  })
  it("reject goes through the atomic function with the reason and returns its status", async () => {
    h.decide.mockResolvedValueOnce({ status: 400, body: { error: "Give a reason", code: "bad_reason" } })
    expect((await patch({ action: "reject", reason: "x" })).status).toBe(400)
    expect(h.decide.mock.calls[0][1]).toMatchObject({ kind: "key", action: "reject", reason: "x" })
    expect(updates()).toHaveLength(0)
  })
  it("revoke updates the key and writes one api_key_revoke audit row with the admin id", async () => {
    expect((await patch({ action: "revoke" })).status).toBe(200)
    expect(updates()).toHaveLength(1)
    expect(audits()).toHaveLength(1)
    expect(audits()[0].payload).toMatchObject({ admin_id: "admin-1", action: "api_key_revoke", target_user_id: "u1" })
  })
  it("set and reset limits each write one api_key_limits audit row", async () => {
    await patch({ action: "set_limits", limits: { purchase: 50 } })
    await patch({ action: "reset_limits" })
    expect(audits().map((a) => a.payload.action)).toEqual(["api_key_limits", "api_key_limits"])
  })
  it("the cron secret (admin with no user id) cannot revoke or change limits: 403, nothing written", async () => {
    ;(globalThis as any).__noAdminId = true
    try {
      expect((await patch({ action: "revoke" })).status).toBe(403)
      expect((await patch({ action: "set_limits", limits: { purchase: 50 } })).status).toBe(403)
      expect(updates()).toHaveLength(0)
    } finally {
      ;(globalThis as any).__noAdminId = false
    }
  })
  it("an audit failure keeps the action and reports auditFailed", async () => {
    h.auditOk = false
    const res = await patch({ action: "revoke" })
    expect(res.status).toBe(200)
    expect((await res.json()).auditFailed).toBe(true)
    expect(updates()).toHaveLength(1)
  })
})
