import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  tables: {} as Record<string, { data: any; error: null | { message: string; code?: string }; count?: number }>,
  heads: {} as Record<string, { data: any; error: null | { message: string }; count?: number }>,
  rpcData: [] as any[], rpcError: null as null | { message: string }, rpcCalls: [] as { fn: string; args: any }[],
  ops: [] as { table: string; ops: { m: string; args: any[] }[] }[],
  settings: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (fn: string, args: any) => { h.rpcCalls.push({ fn, args }); return Promise.resolve({ data: h.rpcData, error: h.rpcError }) },
    from: (table: string) => {
      const ops: { m: string; args: any[] }[] = []
      h.ops.push({ table, ops })
      let head = false
      const c: any = {}
      for (const m of ["select", "eq", "in", "order", "limit", "range", "maybeSingle"]) c[m] = (...args: any[]) => { if (m === "select" && args[1]?.head) head = true; ops.push({ m, args }); return c }
      c.then = (res: any, rej: any) => Promise.resolve((head ? h.heads[table] : h.tables[table]) ?? { data: null, error: null }).then(res, rej)
      return c
    },
  }),
}))
vi.mock("./platform-settings", () => ({ loadSmsSettings: h.settings }))
vi.mock("@/lib/sms-service", () => ({ platformSenderName: () => "TESTSENDER" }))

import { RECORDS_PAGE_SIZE, getHomeSummary, listRecords, listLedger, getRecord } from "./customer-reads"

const SETTINGS = {
  featureEnabled: true,
  senderPool: ["ALERTS", "PAYCO"],
  caps: { platform: { per_send: 300, per_hour: 20, per_day: 500 }, business: { per_send: 1000, per_hour: 2000, per_day: 99 } },
}
const opsOf = (table: string) => h.ops.filter((o) => o.table === table).flatMap((o) => o.ops)

beforeEach(() => {
  h.tables = {}; h.heads = {}; h.rpcData = []; h.rpcError = null; h.rpcCalls = []; h.ops = []
  h.settings.mockReset(); h.settings.mockResolvedValue(SETTINGS)
})

describe("getHomeSummary", () => {
  it("assembles mode, limits from settings caps, 30-day stats, recent ledger and featureEnabled", async () => {
    h.tables.sms_accounts = { data: { mode: "business" }, error: null }
    h.rpcData = [{ campaigns: "4", recipients: "120", credits_used: "130" }]
    h.tables.sms_unit_transactions = {
      data: [{ id: 9, delta: -10, reason: "campaign_send", balance_after: 90, send_log_id: 7, created_at: "2026-10-11T10:00:00Z" }],
      error: null,
    }
    const r = await getHomeSummary("acct1")
    expect(r.mode).toBe("business")
    expect(r.limits).toEqual({ perSend: 1000, perHour: 2000, perDay: 99 })
    expect(r.stats).toEqual({ campaigns: 4, recipients: 120, creditsUsed: 130 })
    expect(r.featureEnabled).toBe(true)
    expect(r.platformSender).toBe("TESTSENDER")
    expect(r.senderPool).toEqual(["ALERTS", "PAYCO"])
    expect(r.defaultSender).toBeNull()
    expect(r.recentLedger).toHaveLength(1)
    expect(r.recentLedger![0]).toMatchObject({ id: 9, delta: -10, label: "SMS campaign #7" })
    expect(h.rpcCalls[0]).toEqual({ fn: "sms_customer_stats", args: { p_account_id: "acct1", p_days: 30 } })
    expect(opsOf("sms_unit_transactions")).toContainEqual({ m: "limit", args: [5] })
    expect(opsOf("sms_unit_transactions")).toContainEqual({ m: "eq", args: ["sms_account_id", "acct1"] })
  })
  it("defaults to platform mode and zero stats when nothing is returned", async () => {
    h.tables.sms_accounts = { data: null, error: null }
    h.tables.sms_unit_transactions = { data: [], error: null }
    h.settings.mockResolvedValue({ ...SETTINGS, featureEnabled: false })
    const r = await getHomeSummary("acct1")
    expect(r.mode).toBe("platform")
    expect(r.limits).toEqual({ perSend: 300, perHour: 20, perDay: 500 })
    expect(r.stats).toEqual({ campaigns: 0, recipients: 0, creditsUsed: 0 })
    expect(r.featureEnabled).toBe(false)
    expect(r.senderPool).toEqual([]) // pool is business-mode only
  })
  it("returns the oldest active own sender as defaultSender", async () => {
    h.tables.sms_accounts = { data: { mode: "platform" }, error: null }
    h.tables.sms_unit_transactions = { data: [], error: null }
    h.tables.sms_sender_ids = { data: { sender_id: "MYSHOP" }, error: null }
    const r = await getHomeSummary("acct1")
    expect(r.defaultSender).toBe("MYSHOP")
    expect(opsOf("sms_sender_ids")).toContainEqual({ m: "order", args: ["created_at", { ascending: true }] })
  })
  it("degrades stats to null (and logs) when the stats RPC fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.tables.sms_accounts = { data: { mode: "platform" }, error: null }
    h.tables.sms_unit_transactions = { data: [], error: null }
    h.rpcError = { message: "stats boom" }
    const r = await getHomeSummary("acct1")
    expect(r.stats).toBeNull()
    expect(r.recentLedger).toEqual([])
    expect(r.featureEnabled).toBe(true)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[SMS-HOME]"), expect.anything())
    spy.mockRestore()
  })
  it("degrades recentLedger to null (and logs) when the ledger read fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.tables.sms_accounts = { data: { mode: "platform" }, error: null }
    h.tables.sms_unit_transactions = { data: null, error: { message: "ledger boom" } }
    h.rpcData = [{ campaigns: 1, recipients: 2, credits_used: 3 }]
    const r = await getHomeSummary("acct1")
    expect(r.recentLedger).toBeNull()
    expect(r.stats).toEqual({ campaigns: 1, recipients: 2, creditsUsed: 3 })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[SMS-HOME]"), expect.anything())
    spy.mockRestore()
  })
  it("still throws when a required read fails (mode, settings, default sender)", async () => {
    h.tables.sms_unit_transactions = { data: [], error: null }
    h.tables.sms_accounts = { data: null, error: { message: "mode boom" } }
    await expect(getHomeSummary("acct1")).rejects.toThrow("mode boom")
    h.tables.sms_accounts = { data: { mode: "platform" }, error: null }
    h.settings.mockRejectedValue(new Error("settings boom"))
    await expect(getHomeSummary("acct1")).rejects.toThrow("settings boom")
    h.settings.mockResolvedValue(SETTINGS)
    h.tables.sms_sender_ids = { data: null, error: { message: "sender boom" } }
    await expect(getHomeSummary("acct1")).rejects.toThrow("sender boom")
  })
})

describe("listRecords", () => {
  it("filters by a known status, pages, orders newest first with an id tiebreaker", async () => {
    h.tables.sms_send_logs = { data: [{ id: 3 }, { id: 2 }], error: null, count: 40 }
    const r = await listRecords("acct1", { status: "held", page: 2 })
    expect(r).toEqual({ rows: [{ id: 3 }, { id: 2 }], total: 40, page: 2, pageSize: RECORDS_PAGE_SIZE })
    expect(RECORDS_PAGE_SIZE).toBe(25)
    const ops = opsOf("sms_send_logs")
    expect(ops).toContainEqual({ m: "eq", args: ["sms_account_id", "acct1"] })
    expect(ops).toContainEqual({ m: "eq", args: ["status", "held"] })
    expect(ops).toContainEqual({ m: "order", args: ["created_at", { ascending: false }] })
    expect(ops).toContainEqual({ m: "order", args: ["id", { ascending: false }] })
    expect(ops).toContainEqual({ m: "range", args: [25, 49] })
  })
  it("treats an unknown status as no filter", async () => {
    h.tables.sms_send_logs = { data: [], error: null, count: 0 }
    await listRecords("acct1", { status: "drop table", page: 1 })
    expect(opsOf("sms_send_logs").some((o) => o.m === "eq" && o.args[0] === "status")).toBe(false)
  })
  it("throws on a DB error", async () => {
    h.tables.sms_send_logs = { data: null, error: { message: "boom" } }
    await expect(listRecords("acct1", { status: "", page: 1 })).rejects.toThrow("boom")
  })
  it("selects scheduled_for + source and filters the 'scheduled' status", async () => {
    h.tables.sms_send_logs = { data: [{ id: 3, status: "scheduled", scheduled_for: "2026-10-20T09:30:00Z", source: "campaign" }], error: null, count: 1 }
    const r = await listRecords("acct1", { status: "scheduled", page: 1 })
    expect(r.rows[0]).toMatchObject({ scheduled_for: "2026-10-20T09:30:00Z", source: "campaign" })
    const sel = opsOf("sms_send_logs").find((o) => o.m === "select")!
    expect(sel.args[0]).toMatch(/\bscheduled_for\b/)
    expect(sel.args[0]).toMatch(/\bsource\b/)
    expect(opsOf("sms_send_logs")).toContainEqual({ m: "eq", args: ["status", "scheduled"] })
  })
})

describe("before the Phase 4 migration (columns missing)", () => {
  // Mimics PostgREST: selecting an unknown column fails with 42703; the legacy column list works.
  const missingCols = () => {
    let n = 0
    Object.defineProperty(h.tables, "sms_send_logs", {
      configurable: true, enumerable: true,
      get: () => (n++ === 0
        ? { data: null, error: { message: "column sms_send_logs.scheduled_for does not exist", code: "42703" } }
        : { data: [{ id: 3, status: "sent" }], error: null, count: 1 }),
    })
  }
  it("listRecords retries with the legacy columns", async () => {
    missingCols()
    const r = await listRecords("acct1", { status: "", page: 1 })
    expect(r.rows).toEqual([{ id: 3, status: "sent" }])
    const sels = opsOf("sms_send_logs").filter((o) => o.m === "select").map((o) => o.args[0] as string)
    expect(sels).toHaveLength(2)
    expect(sels[1]).not.toMatch(/scheduled_for|source/)
  })
  it("getRecord retries with the legacy columns", async () => {
    missingCols()
    h.tables.sms_messages = { data: [], error: null }
    const r = await getRecord("acct1", 3)
    // the fake client returns an array for the single-row read; the log is rebuilt by object spread
    expect(r?.log).toEqual({ "0": { id: 3, status: "sent" } })
    const sels = opsOf("sms_send_logs").filter((o) => o.m === "select").map((o) => o.args[0] as string)
    expect(sels).toHaveLength(2)
    expect(sels[1]).not.toMatch(/scheduled_for|source/)
  })
  it("other errors are not retried", async () => {
    h.tables.sms_send_logs = { data: null, error: { message: "boom", code: "XX000" } }
    await expect(listRecords("acct1", { status: "", page: 1 })).rejects.toThrow("boom")
    expect(opsOf("sms_send_logs").filter((o) => o.m === "select")).toHaveLength(1)
  })
})

describe("out-of-range pages", () => {
  it("listRecords returns empty rows with the head-count total instead of throwing", async () => {
    h.tables.sms_send_logs = { data: null, error: { message: "Requested range not satisfiable", code: "PGRST103" } }
    h.heads.sms_send_logs = { data: null, error: null, count: 12 }
    expect(await listRecords("acct1", { status: "held", page: 9 })).toEqual({ rows: [], total: 12, page: 9, pageSize: RECORDS_PAGE_SIZE })
    expect(opsOf("sms_send_logs")).toContainEqual({ m: "eq", args: ["status", "held"] })
  })
  it("listLedger returns empty rows with the head-count total instead of throwing", async () => {
    h.tables.sms_unit_transactions = { data: null, error: { message: "Requested range not satisfiable", code: "PGRST103" } }
    h.heads.sms_unit_transactions = { data: null, error: null, count: 7 }
    expect(await listLedger("acct1", 5)).toEqual({ rows: [], total: 7, page: 5, pageSize: RECORDS_PAGE_SIZE })
  })
})

describe("listLedger", () => {
  it("returns labelled rows, newest first, scoped and paged", async () => {
    h.tables.sms_unit_transactions = {
      data: [
        { id: 2, delta: 50, reason: "bundle_wallet", balance_after: 60, send_log_id: null, created_at: "t2" },
        { id: 1, delta: 10, reason: "welcome_bonus", balance_after: 10, send_log_id: null, created_at: "t1" },
      ],
      error: null, count: 2,
    }
    const r = await listLedger("acct1", 1)
    expect(r.rows.map((x) => x.label)).toEqual(["Credits purchased", "Welcome bonus"])
    expect(r).toMatchObject({ total: 2, page: 1, pageSize: RECORDS_PAGE_SIZE })
    const ops = opsOf("sms_unit_transactions")
    expect(ops).toContainEqual({ m: "eq", args: ["sms_account_id", "acct1"] })
    expect(ops).toContainEqual({ m: "range", args: [0, 24] })
  })
  it("labels refunds, support credits and unknown reasons", async () => {
    h.tables.sms_unit_transactions = {
      data: [
        { id: 3, delta: 2, reason: "campaign_refund", balance_after: 1, send_log_id: 5, created_at: "t" },
        { id: 2, delta: 2, reason: "admin_alloc", balance_after: 1, send_log_id: null, created_at: "t" },
        { id: 1, delta: 2, reason: "weird", balance_after: 1, send_log_id: null, created_at: "t" },
      ],
      error: null, count: 3,
    }
    const r = await listLedger("acct1", 1)
    expect(r.rows.map((x) => x.label)).toEqual(["Refund — campaign #5", "Credits added by support", "Credit adjustment"])
  })
  it("throws on a DB error", async () => {
    h.tables.sms_unit_transactions = { data: null, error: { message: "boom" } }
    await expect(listLedger("acct1", 1)).rejects.toThrow("boom")
  })
  describe("order confirmation debits", () => {
    const ledger = [
      { id: 3, delta: -1, reason: "campaign_send", balance_after: 9, send_log_id: 11, created_at: "t" },
      { id: 2, delta: -4, reason: "campaign_send", balance_after: 10, send_log_id: 10, created_at: "t" },
      { id: 1, delta: 50, reason: "bundle_wallet", balance_after: 14, send_log_id: null, created_at: "t" },
    ]
    it("labels debits whose send log source is order_confirmation (one scoped lookup)", async () => {
      h.tables.sms_unit_transactions = { data: ledger, error: null, count: 3 }
      h.tables.sms_send_logs = { data: [{ id: 11, source: "order_confirmation" }, { id: 10, source: null }], error: null }
      const r = await listLedger("acct1", 1)
      expect(r.rows.map((x) => x.label)).toEqual(["Order confirmation SMS", "SMS campaign #10", "Credits purchased"])
      const ops = opsOf("sms_send_logs")
      expect(ops).toContainEqual({ m: "eq", args: ["sms_account_id", "acct1"] })
      expect(ops).toContainEqual({ m: "in", args: ["id", [11, 10]] })
    })
    it("keeps default labels (and does not throw) when the lookup fails or the column is missing", async () => {
      h.tables.sms_unit_transactions = { data: ledger, error: null, count: 3 }
      h.tables.sms_send_logs = { data: null, error: { message: "no col", code: "42703" } }
      const r = await listLedger("acct1", 1)
      expect(r.rows.map((x) => x.label)).toEqual(["SMS campaign #11", "SMS campaign #10", "Credits purchased"])
    })
    it("skips the lookup when there are no campaign debits", async () => {
      h.tables.sms_unit_transactions = { data: [ledger[2]], error: null, count: 1 }
      await listLedger("acct1", 1)
      expect(opsOf("sms_send_logs")).toEqual([])
    })
    it("getHomeSummary labels them too", async () => {
      h.tables.sms_accounts = { data: { mode: "platform" }, error: null }
      h.tables.sms_unit_transactions = { data: [ledger[0]], error: null }
      h.tables.sms_send_logs = { data: [{ id: 11, source: "order_confirmation" }], error: null }
      const r = await getHomeSummary("acct1")
      expect(r.recentLedger![0].label).toBe("Order confirmation SMS")
    })
  })
})

describe("cancelled flag (derived from policy_shadow, which is never exposed)", () => {
  const shadow = (outcome: string) => ({ review: { outcome } })
  it("listRecords marks failed logs whose review outcome is cancelled and strips policy_shadow", async () => {
    h.tables.sms_send_logs = { data: [
      { id: 5, status: "failed", policy_shadow: shadow("cancelled") },
      { id: 4, status: "failed", policy_shadow: shadow("rejected") },
      { id: 3, status: "sent", policy_shadow: shadow("cancelled") },
    ], error: null, count: 3 }
    const r = await listRecords("acct1", { status: "", page: 1 })
    expect(r.rows.map((x) => x.cancelled)).toEqual([true, false, undefined])
    expect(r.rows.every((x) => !("policy_shadow" in x))).toBe(true)
    const shadowQ = opsOf("sms_send_logs").find((o) => o.m === "in")!
    expect(shadowQ.args).toEqual(["id", [5, 4]])
  })
  it("getRecord derives cancelled for a failed log", async () => {
    h.tables.sms_send_logs = { data: { id: 7, status: "failed", policy_shadow: shadow("cancelled") }, error: null }
    h.tables.sms_messages = { data: [], error: null }
    const r = await getRecord("acct1", 7)
    expect(r?.log).toMatchObject({ id: 7, cancelled: true })
    expect(r?.log).not.toHaveProperty("policy_shadow")
  })
  it("a failed policy_shadow read degrades to not cancelled (no throw)", async () => {
    h.tables.sms_send_logs = { data: [{ id: 5, status: "failed" }], error: null, count: 1 }
    const r = await listRecords("acct1", { status: "failed", page: 1 })
    expect(r.rows[0].cancelled).toBe(false)
  })
})

describe("getRecord", () => {
  it("returns the log, messages and delivery counts", async () => {
    h.tables.sms_send_logs = { data: { id: 7, status: "sent" }, error: null }
    h.tables.sms_messages = {
      data: [
        { id: "a", phone: "1", status: "sent", delivery_status: "delivered", refunded: false },
        { id: "b", phone: "2", status: "sent", delivery_status: "failed", refunded: true },
        { id: "c", phone: "3", status: "failed", delivery_status: "pending", refunded: true },
        { id: "d", phone: "4", status: "sent", delivery_status: "pending", refunded: false },
      ],
      error: null,
    }
    const r = await getRecord("acct1", 7)
    expect(r?.log).toEqual({ id: 7, status: "sent" })
    expect(r?.messages).toHaveLength(4)
    expect(r?.counts).toEqual({ delivered: 1, failed: 2, pending: 1, refunded: 2 })
    expect(opsOf("sms_send_logs")).toContainEqual({ m: "eq", args: ["sms_account_id", "acct1"] })
    expect(opsOf("sms_messages")).toContainEqual({ m: "eq", args: ["sms_account_id", "acct1"] })
    const sel = opsOf("sms_send_logs").find((o) => o.m === "select")!
    expect(sel.args[0]).toMatch(/\bscheduled_for\b/)
    expect(sel.args[0]).toMatch(/\bsource\b/)
  })
  it("returns null when the batch is not the account's", async () => {
    h.tables.sms_send_logs = { data: null, error: null }
    expect(await getRecord("acct1", 7)).toBeNull()
  })
  it("throws on a DB error", async () => {
    h.tables.sms_send_logs = { data: { id: 7 }, error: null }
    h.tables.sms_messages = { data: null, error: { message: "boom" } }
    await expect(getRecord("acct1", 7)).rejects.toThrow("boom")
  })
})
