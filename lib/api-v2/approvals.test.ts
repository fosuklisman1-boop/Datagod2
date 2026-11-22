import { describe, it, expect, vi } from "vitest"
import { DECISION_STATUS, decide, listApprovals, matchesQuery, removeGrant, rpcOutcome, type ApprovalItem } from "./approvals"
import { auditApi } from "./admin-audit"

type World = {
  tables?: Record<string, any[] | { error: any }>
  rpc?: Record<string, { data?: any; error?: any } | ((args: any) => { data?: any; error?: any })>
}

/** Fake service client: selects answer from `tables`, rpc from `rpc`; every call is recorded. */
function fake(w: World = {}) {
  const calls: any[] = []
  const client: any = {
    rpc(fn: string, args: any) {
      calls.push({ rpc: fn, args })
      const r = w.rpc?.[fn]
      const out = typeof r === "function" ? r(args) : r ?? { data: null, error: null }
      return Promise.resolve({ data: out.data ?? null, error: out.error ?? null })
    },
    from(table: string) {
      const rec: any = { table, op: "select", filters: [] as any[] }
      calls.push(rec)
      const result = () => {
        if (rec.op === "insert") return { data: null, error: (w.tables?.[table] as any)?.error ?? null }
        const t = w.tables?.[table]
        if (t && !Array.isArray(t)) return { data: null, error: t.error }
        let rows = (t as any[]) ?? []
        for (const [op, c, v] of rec.filters) {
          if (op === "eq") rows = rows.filter((r) => r[c] === v)
          if (op === "in") rows = rows.filter((r) => v.includes(r[c]))
        }
        return rec.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length }
      }
      const b: any = {
        select() { return b },
        insert(p: any) { rec.op = "insert"; rec.payload = p; return b },
        eq(c: string, v: any) { rec.filters.push(["eq", c, v]); return b },
        in(c: string, v: any) { rec.filters.push(["in", c, v]); return b },
        like() { return b },
        order() { return b },
        range() { return b },
        limit() { return b },
        maybeSingle() { rec.single = true; return Promise.resolve(result()) },
        then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej) },
      }
      return b
    },
  }
  return { client, calls }
}
const rpcCalls = (calls: any[]) => calls.filter((c) => c.rpc)

describe("rpcOutcome and DECISION_STATUS", () => {
  it("maps every decision code to its HTTP status", () => {
    expect(DECISION_STATUS).toEqual({ not_found: 404, stale: 409, suspended: 409, not_eligible: 409, bad_reason: 400, busy: 503, error: 500 })
    for (const code of ["not_found", "stale", "suspended", "not_eligible", "bad_reason"]) {
      expect(rpcOutcome({ data: { ok: false, code }, error: null })).toEqual({ ok: false, code })
    }
  })
  it("a lock timeout or deadlock is busy (retryable); any other error or unknown code is error", () => {
    expect(rpcOutcome({ data: null, error: { code: "55P03" } })).toEqual({ ok: false, code: "busy" })
    expect(rpcOutcome({ data: null, error: { code: "40P01" } })).toEqual({ ok: false, code: "busy" })
    expect(rpcOutcome({ data: null, error: { code: "XX000" } })).toEqual({ ok: false, code: "error" })
    expect(rpcOutcome({ data: { ok: false, code: "weird" }, error: null })).toEqual({ ok: false, code: "error" })
    expect(rpcOutcome({ data: { ok: true, user_id: "u1" }, error: null })).toEqual({ ok: true, data: { ok: true, user_id: "u1" } })
  })
})

describe("decide", () => {
  const keyRow = { id: "k1", user_id: "u1", key_type: "standard", request_code: "API-7K3Q9M" }

  it("approve key: calls api_v2_approve_key with the admin as actor and notifies once", async () => {
    const notify = vi.fn(async () => [])
    const { client, calls } = fake({ tables: { api_v2_keys: [keyRow] }, rpc: { api_v2_approve_key: { data: { ok: true, user_id: "u1", key_type: "standard", replaced_key_id: null } } } })
    const r = await decide(client, { kind: "key", action: "approve", id: "k1", actorId: "admin-1" }, { notify })
    expect(r.status).toBe(200)
    expect(rpcCalls(calls)).toEqual([{ rpc: "api_v2_approve_key", args: { p_key: "k1", p_actor: "admin-1" } }])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith("api_access", "approved", { userId: "u1", reference: "API-7K3Q9M" }, expect.objectContaining({ kind: "key", code: "API-7K3Q9M", keyType: "standard" }))
  })

  it("approving a swap tells the developer it was a swap", async () => {
    const notify = vi.fn(async () => [])
    const { client } = fake({ tables: { api_v2_keys: [keyRow] }, rpc: { api_v2_approve_key: { data: { ok: true, user_id: "u1", key_type: "standard", replaced_key_id: "k0" } } } })
    await decide(client, { kind: "key", action: "approve", id: "k1", actorId: "admin-1" }, { notify })
    expect((notify.mock.calls[0] as any)[3]).toMatchObject({ kind: "swap" })
  })

  it("reject key: passes the reason, notifies with it, and bad_reason is 400 with no notification", async () => {
    const notify = vi.fn(async () => [])
    const ok = fake({ tables: { api_v2_keys: [keyRow] }, rpc: { api_v2_reject_key: { data: { ok: true, user_id: "u1" } } } })
    const r = await decide(ok.client, { kind: "key", action: "reject", id: "k1", actorId: "admin-1", reason: "Not enough history" }, { notify })
    expect(r.status).toBe(200)
    expect(rpcCalls(ok.calls)[0]).toEqual({ rpc: "api_v2_reject_key", args: { p_key: "k1", p_actor: "admin-1", p_reason: "Not enough history" } })
    expect((notify.mock.calls[0] as any)[3]).toMatchObject({ reason: "Not enough history" })
    notify.mockClear()
    const bad = fake({ tables: { api_v2_keys: [keyRow] }, rpc: { api_v2_reject_key: { data: { ok: false, code: "bad_reason" } } } })
    expect((await decide(bad.client, { kind: "key", action: "reject", id: "k1", actorId: "admin-1", reason: "x" }, { notify })).status).toBe(400)
    expect(notify).not.toHaveBeenCalled()
  })

  it("access requests use the access functions", async () => {
    const { client, calls } = fake({
      tables: { api_v2_access_requests: [{ id: "r1", user_id: "u2", request_code: "API-M4T8WX" }] },
      rpc: { api_v2_approve_access: { data: { ok: true, user_id: "u2" } } },
    })
    const notify = vi.fn(async () => [])
    expect((await decide(client, { kind: "access", action: "approve", id: "r1", actorId: "admin-1" }, { notify })).status).toBe(200)
    expect(rpcCalls(calls)[0]).toEqual({ rpc: "api_v2_approve_access", args: { p_request: "r1", p_actor: "admin-1" } })
    expect((notify.mock.calls[0] as any)[3]).toMatchObject({ kind: "access", code: "API-M4T8WX" })
  })

  it("each failure maps to its status and never notifies", async () => {
    for (const [code, status] of Object.entries(DECISION_STATUS)) {
      const notify = vi.fn(async () => [])
      const res = code === "busy" ? { error: { code: "55P03" } } : code === "error" ? { error: { code: "XX000" } } : { data: { ok: false, code } }
      const { client } = fake({ rpc: { api_v2_approve_key: res } })
      expect((await decide(client, { kind: "key", action: "approve", id: "k1", actorId: "admin-1" }, { notify })).status).toBe(status)
      expect(notify).not.toHaveBeenCalled()
    }
  })

  it("a notifier that throws still answers 200", async () => {
    const notify = vi.fn(async () => { throw new Error("down") })
    const { client } = fake({ rpc: { api_v2_approve_key: { data: { ok: true, user_id: "u1" } } } })
    expect((await decide(client, { kind: "key", action: "approve", id: "k1", actorId: "admin-1" }, { notify })).status).toBe(200)
  })

  it("without an admin account (e.g. the cron secret) nothing is decided", async () => {
    const { client, calls } = fake()
    expect((await decide(client, { kind: "key", action: "approve", id: "k1", actorId: undefined }, { notify: vi.fn() })).status).toBe(403)
    expect(rpcCalls(calls)).toHaveLength(0)
  })
})

describe("removeGrant", () => {
  it("calls api_v2_remove_grant and tells the developer", async () => {
    const notify = vi.fn(async () => [])
    const { client, calls } = fake({ rpc: { api_v2_remove_grant: { data: { ok: true, user_id: "u2" } } } })
    expect((await removeGrant(client, { userId: "u2", actorId: "admin-1", reason: "Misuse" }, { notify })).status).toBe(200)
    expect(rpcCalls(calls)[0]).toEqual({ rpc: "api_v2_remove_grant", args: { p_user: "u2", p_actor: "admin-1", p_reason: "Misuse" } })
    expect(notify).toHaveBeenCalledWith("api_access", "removed", { userId: "u2" }, { kind: "access", reason: "Misuse" })
  })
})

describe("matchesQuery", () => {
  const item = {
    code: "API-7K3Q9M",
    owner: { name: "Ama Kofi", email: "ama@example.com", phone: "0241234567" },
  } as unknown as ApprovalItem
  it("finds the code case-insensitively, and the name, email and phone", () => {
    for (const q of ["api-7k3q9m", "7K3Q", "ama kofi", "EXAMPLE.com", "024 123", "+233241234567".slice(4)]) expect(matchesQuery(item, q)).toBe(true)
    expect(matchesQuery(item, "")).toBe(true)
  })
  it("filter-syntax characters are plain text and match nothing special", () => {
    for (const q of [",", "().%", "status.eq.pending", "a,b", "%"]) expect(matchesQuery(item, q)).toBe(false)
  })
})

describe("listApprovals", () => {
  const base = {
    api_v2_keys: [
      { id: "k1", user_id: "u1", key_type: "standard", environment: "live", status: "pending", request_code: "API-7K3Q9M", created_at: "2026-11-22T10:00:00Z" },
      { id: "k0", user_id: "u1", key_type: "standard", environment: "live", status: "active", request_code: null, created_at: "2026-11-01T10:00:00Z" },
    ],
    api_v2_access_requests: [{ id: "r1", user_id: "u2", status: "pending", request_code: "API-M4T8WX", created_at: "2026-11-22T09:00:00Z" }],
    users: [
      { id: "u1", first_name: "Ama", last_name: "Kofi", email: "ama@example.com", phone_number: "0241234567", role: "dealer", is_suspended: false },
      { id: "u2", first_name: "Yaw", last_name: null, email: "yaw@example.com", phone_number: "0551112222", role: "user", is_suspended: false },
    ],
    api_v2_access_grants: [],
    api_v2_config: [{ id: true, enabled: true, allowed_roles: ["dealer"] }],
  }
  const signals = { data: { u1: { created_at: "2026-01-01T00:00:00Z", wallet_balance: 50, phone_number: "0241234567", phone_verified: true, same_phone_accounts: 1 } } }

  it("lists pending keys and access requests oldest first, marks a swap, and attaches context", async () => {
    const { client } = fake({ tables: base, rpc: { admin_user_signals: signals, api_v2_approval_context: { data: { u1: { topups_30d: 200, orders_30d: 9 } } } } })
    const r = await listApprovals(client, { q: "", page: 0 })
    if (r === "error") throw new Error("error")
    expect(r.total).toBe(2)
    expect(r.items.map((i) => [i.kind, i.code])).toEqual([["access", "API-M4T8WX"], ["swap", "API-7K3Q9M"]])
    const k = r.items[1]
    expect(k.owner).toMatchObject({ name: "Ama Kofi", phone: "0241234567", role: "dealer", eligible: true, phoneVerified: true, samePhoneAccounts: 1, accountCreatedAt: "2026-01-01T00:00:00Z" })
    expect(k.context).toEqual({ balance: 50, topups30d: 200, orders30d: 9 })
    expect(r.items[0].owner.eligible).toBe(false)
  })

  it("a context failure still lists the items, with context null", async () => {
    const { client } = fake({ tables: base, rpc: { admin_user_signals: signals, api_v2_approval_context: { error: { message: "x" } } } })
    const r = await listApprovals(client, { q: "", page: 0 })
    if (r === "error") throw new Error("error")
    expect(r.items).toHaveLength(2)
    expect(r.items.every((i) => i.context === null)).toBe(true)
  })

  it("filters by q before paginating", async () => {
    const { client } = fake({ tables: base })
    const r = await listApprovals(client, { q: "api-7k3q9m", page: 0 })
    if (r === "error") throw new Error("error")
    expect(r.total).toBe(1)
    expect(r.items[0].code).toBe("API-7K3Q9M")
  })

  it("a failed read of keys, requests or owners is an error, never a partial inbox", async () => {
    for (const t of ["api_v2_keys", "api_v2_access_requests", "users"]) {
      const { client } = fake({ tables: { ...base, [t]: { error: { message: "x" } } } })
      expect(await listApprovals(client, { q: "", page: 0 })).toBe("error")
    }
  })
})

describe("auditApi", () => {
  it("writes one admin_audit_log row and reports success", async () => {
    const { client, calls } = fake()
    expect(await auditApi(client, { adminId: "admin-1", action: "api_key_revoke", targetUserId: "u1", after: { key_id: "k1" } })).toBe(true)
    const ins = calls.find((c) => c.op === "insert")
    expect(ins.table).toBe("admin_audit_log")
    expect(ins.payload).toEqual({ admin_id: "admin-1", action: "api_key_revoke", target_user_id: "u1", old_value: null, new_value: { key_id: "k1" } })
  })
  it("returns false on failure or a missing admin, never throws", async () => {
    expect(await auditApi(fake({ tables: { admin_audit_log: { error: { message: "x" } } } }).client, { adminId: "a", action: "api_config" })).toBe(false)
    expect(await auditApi({ from() { throw new Error("boom") } } as any, { adminId: "a", action: "api_config" })).toBe(false)
    expect(await auditApi(fake().client, { adminId: undefined, action: "api_config" })).toBe(false)
  })
  it("refuses an action outside the api_ namespace", async () => {
    expect(await auditApi(fake().client, { adminId: "a", action: "wallet_credit" })).toBe(false)
  })
})
