import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  type Row = { id: string; status: string; user_id: string; flagged: boolean; flag_reason: string | null }

  const state = {
    account: null as Row | null,
    logRow: null as Row | null,
    rpcError: false,
    updateError: false,
    auditRows: [] as unknown[],
    rpcCallArgs: null as unknown,
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
        return Promise.resolve({ data: null, error: null })
      },
      update: (_patch: unknown) => ({
        eq: (_c: string, _v: string) => Promise.resolve({ data: null, error: state.updateError ? { message: "update failed" } : null }),
      }),
      order: (_col: string, _opts?: unknown) => Promise.resolve({ data: [], error: null }),
      upsert: (_rows: unknown, _opts?: unknown) => Promise.resolve({ data: null, error: null }),
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

import { suspendSmsAccount, dismissFlag } from "./moderation-service"

beforeEach(() => {
  h.state.account = null
  h.state.logRow = null
  h.state.rpcError = false
  h.state.updateError = false
  h.state.auditRows.length = 0
  h.state.rpcCallArgs = null
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

  it("update error → 400 returned, no audit log written", async () => {
    h.state.logRow = { id: "l1", status: "sent", user_id: "u1", flagged: true, flag_reason: "test" }
    h.state.updateError = true
    const res = await dismissFlag("admin1", "l1")
    expect(res.ok).toBe(false)
    expect((res as { status: number }).status).toBe(400)
    expect(h.state.auditRows).toHaveLength(0)
  })
})
