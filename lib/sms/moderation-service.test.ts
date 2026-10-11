import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  type Row = { id: string; status: string; user_id: string; flagged: boolean; flag_reason: string | null }

  const state = {
    account: null as Row | null,
    logRow: null as Row | null,
    rpcError: false,
    updateError: false,
    updateRows: [{ id: "x" }] as unknown[],
    updateEqs: [] as [string, unknown][],
    auditRows: [] as unknown[],
    auditError: false,
    rpcCallArgs: null as unknown,
    upsertRows: null as any,
  }

  const fake = {
    from: (table: string) => ({
      select: (_cols?: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: () => {
            if (table === "sms_accounts")
              return Promise.resolve({ data: state.account, error: state.account ? null : { message: "not found" } })
            if (table === "sms_send_logs")
              return Promise.resolve({ data: state.logRow, error: state.logRow ? null : { message: "not found" } })
            return Promise.resolve({ data: null, error: null })
          },
        }),
        in: (_col: string, _vals: string[]) => Promise.resolve({ data: [], error: null }),
        order: (_col: string, _opts?: unknown) => ({
          limit: (_n: number) => Promise.resolve({ data: [], error: null }),
        }),
      }),
      insert: (row: unknown) => {
        if (table === "admin_audit_log") state.auditRows.push(row)
        return Promise.resolve({ data: null, error: table === "admin_audit_log" && state.auditError ? { message: "audit down" } : null })
      },
      update: (_patch: unknown) => {
        const eqs: [string, unknown][] = []
        const c: any = {
          eq: (col: string, v: unknown) => { eqs.push([col, v]); state.updateEqs = eqs; return c },
          select: (_cols?: string) => c,
          then: (res: any, rej: any) =>
            Promise.resolve({
              data: state.updateError ? null : state.updateRows,
              error: state.updateError ? { message: "update failed" } : null,
            }).then(res, rej),
        }
        return c
      },
      order: (_col: string, _opts?: unknown) => Promise.resolve({ data: [], error: null }),
      upsert: (rows: any, _opts?: unknown) => { state.upsertRows = rows; return Promise.resolve({ data: null, error: null }) },
    }),
    rpc: (fn: string, args: unknown) => {
      state.rpcCallArgs = { fn, args }
      if (fn === "suspend_sms_account") {
        if (state.rpcError) return Promise.resolve({ data: null, error: { message: "inactive account" } })
        const suspended = (args as { p_suspended: boolean }).p_suspended
        return Promise.resolve({ data: suspended ? "suspended" : "active", error: null })
      }
      return Promise.resolve({
        data: [{ activationCount: 0, activationTotal: 0, bundleUnitsSold: 0, bundleGhsTotal: 0 }],
        error: null,
      })
    },
  }

  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("./revenue-aggregation", () => ({
  aggregateRevenue: (_raw: unknown) => ({ activations: 0, activationTotal: 0, bundleTotal: 0, creditsSold: 0 }),
}))

import { suspendSmsAccount, dismissFlag, updateSmsSettings, writeAuditLog } from "./moderation-service"

beforeEach(() => {
  h.state.account = null
  h.state.logRow = null
  h.state.rpcError = false
  h.state.updateError = false
  h.state.updateRows = [{ id: "x" }]
  h.state.updateEqs = []
  h.state.auditRows.length = 0
  h.state.auditError = false
  h.state.rpcCallArgs = null
  h.state.upsertRows = null
})

describe("writeAuditLog", () => {
  it("logs (does not swallow) a failed insert with action and target", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.state.auditError = true
    await expect(writeAuditLog("a1", "some_action", "u9", null, { x: 1 })).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("action=some_action, target=u9"), "audit down")
    spy.mockRestore()
  })
})

describe("suspendSmsAccount", () => {
  it("account not found → error", async () => {
    const res = await suspendSmsAccount("admin1", "acc-missing", true)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/not found/)
    expect(h.state.auditRows).toHaveLength(0)
  })

  it("active account → RPC called with p_account_id + p_suspended=true, audit log written", async () => {
    h.state.account = { id: "acc1", status: "active", user_id: "u1", flagged: false, flag_reason: null }
    const res = await suspendSmsAccount("admin1", "acc1", true)
    expect(res.ok).toBe(true)
    expect((res as { newStatus: string }).newStatus).toBe("suspended")
    // ── Critical: assert the exact RPC arg names (PGRST202 guard) ──
    const call = h.state.rpcCallArgs as { fn: string; args: { p_account_id: string; p_suspended: boolean } }
    expect(call.fn).toBe("suspend_sms_account")
    expect(call.args).toHaveProperty("p_account_id", "acc1")
    expect(call.args).toHaveProperty("p_suspended", true)
    expect(h.state.auditRows).toHaveLength(1)
  })

  it("RPC errors (e.g. inactive account) → error propagated, no audit log", async () => {
    h.state.account = { id: "acc1", status: "active", user_id: "u1", flagged: false, flag_reason: null }
    h.state.rpcError = true
    const res = await suspendSmsAccount("admin1", "acc1", true)
    expect(res.ok).toBe(false)
    expect(h.state.auditRows).toHaveLength(0)
  })

  it("unsuspend → p_suspended=false arg sent, audit action is sms_unsuspend", async () => {
    h.state.account = { id: "acc1", status: "suspended", user_id: "u1", flagged: false, flag_reason: null }
    await suspendSmsAccount("admin1", "acc1", false)
    const call = h.state.rpcCallArgs as { fn: string; args: { p_account_id: string; p_suspended: boolean } }
    expect(call.args.p_suspended).toBe(false)
    expect(call.args.p_account_id).toBe("acc1")
    const auditRow = h.state.auditRows[0] as { action: string }
    expect(auditRow.action).toBe("sms_unsuspend")
  })
})

describe("dismissFlag", () => {
  it("log not found → 404", async () => {
    const res = await dismissFlag("admin1", "log-missing")
    expect(res.ok).toBe(false)
    expect((res as { status: number }).status).toBe(404)
  })

  it("log exists but not flagged → 404", async () => {
    h.state.logRow = { id: "l1", status: "sent", user_id: "u1", flagged: false, flag_reason: null }
    const res = await dismissFlag("admin1", "l1")
    expect(res.ok).toBe(false)
    expect((res as { status: number }).status).toBe(404)
  })

  it("flagged log → cleared, audit row written with correct fields", async () => {
    h.state.logRow = { id: "l1", status: "sent", user_id: "u1", flagged: true, flag_reason: "keyword:loan" }
    const res = await dismissFlag("admin1", "l1")
    expect(res.ok).toBe(true)
    expect(h.state.auditRows).toHaveLength(1)
    const auditRow = h.state.auditRows[0] as { action: string; old_value: { flagged: boolean; flag_reason: string } }
    expect(auditRow.action).toBe("sms_flag_dismiss")
    expect(auditRow.old_value.flagged).toBe(true)
    expect(auditRow.old_value.flag_reason).toBe("keyword:loan")
  })

  it("update is guarded on flagged=true; 0 rows updated (race) → 404, no audit", async () => {
    h.state.logRow = { id: "l1", status: "sent", user_id: "u1", flagged: true, flag_reason: "test" }
    h.state.updateRows = []
    const res = await dismissFlag("admin1", "l1")
    expect(h.state.updateEqs).toContainEqual(["flagged", true])
    expect(res).toEqual({ ok: false, error: "Log entry is not flagged", status: 404 })
    expect(h.state.auditRows).toHaveLength(0)
  })

  it("update error → 400 returned, no audit log written", async () => {
    h.state.logRow = { id: "l1", status: "sent", user_id: "u1", flagged: true, flag_reason: "test" }
    h.state.updateError = true
    const res = await dismissFlag("admin1", "l1")
    expect(res.ok).toBe(false)
    expect((res as { status: number }).status).toBe(400)
    expect(h.state.auditRows).toHaveLength(0)
  })
})

describe("updateSmsSettings", () => {
  it("upserts ONLY {key, value} (no phantom updated_at column) for allowed keys", async () => {
    const res = await updateSmsSettings({ sms_activation_fee: { amount: 30 }, bogus_key: 1 } as any)
    expect(res.ok).toBe(true)
    // Only the allowed key is upserted, and each row has exactly key+value (the table has no updated_at).
    expect(h.state.upsertRows).toEqual([{ key: "sms_activation_fee", value: { amount: 30 } }])
    for (const row of h.state.upsertRows as any[]) {
      expect(Object.keys(row).sort()).toEqual(["key", "value"])
    }
  })

  it("no valid keys → ok:false, no upsert", async () => {
    const res = await updateSmsSettings({ not_allowed: 1 } as any)
    expect(res.ok).toBe(false)
    expect(h.state.upsertRows).toBeNull()
  })
})
