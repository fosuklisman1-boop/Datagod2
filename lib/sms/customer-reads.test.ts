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
      for (const m of ["select", "eq", "order", "limit", "range", "maybeSingle"]) c[m] = (...args: any[]) => { if (m === "select" && args[1]?.head) head = true; ops.push({ m, args }); return c }
      c.then = (res: any, rej: any) => Promise.resolve((head ? h.heads[table] : h.tables[table]) ?? { data: null, error: null }).then(res, rej)
      return c
    },
  }),
}))
vi.mock("./platform-settings", () => ({ loadSmsSettings: h.settings }))

import { RECORDS_PAGE_SIZE, getHomeSummary, listRecords, listLedger, getRecord } from "./customer-reads"

const SETTINGS = {
  featureEnabled: true,
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
    expect(r.recentLedger).toHaveLength(1)
    expect(r.recentLedger[0]).toMatchObject({ id: 9, delta: -10, label: "SMS campaign #7" })
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
  })
  it("throws on a stats RPC error", async () => {
    h.tables.sms_accounts = { data: { mode: "platform" }, error: null }
    h.tables.sms_unit_transactions = { data: [], error: null }
    h.rpcError = { message: "stats boom" }
    await expect(getHomeSummary("acct1")).rejects.toThrow("stats boom")
  })
  it("throws on a ledger error", async () => {
    h.tables.sms_accounts = { data: { mode: "platform" }, error: null }
    h.tables.sms_unit_transactions = { data: null, error: { message: "ledger boom" } }
    await expect(getHomeSummary("acct1")).rejects.toThrow("ledger boom")
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
