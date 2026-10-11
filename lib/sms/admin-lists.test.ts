import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  rpcData: [] as any[], rpcError: null as null | { message: string }, rpcCalls: [] as { fn: string; args: any }[],
  tableResult: { data: null as any, error: null as null | { message: string } },
  ops: [] as { table: string; ops: { m: string; args: any[] }[] }[],
  dismiss: vi.fn(), suspend: vi.fn(), audit: vi.fn(() => Promise.resolve()),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (fn: string, args: any) => { h.rpcCalls.push({ fn, args }); return Promise.resolve({ data: h.rpcData, error: h.rpcError }) },
    from: (table: string) => {
      const ops: { m: string; args: any[] }[] = []
      h.ops.push({ table, ops })
      const c: any = {}
      for (const m of ["select", "update", "eq", "is", "in", "maybeSingle", "single"]) c[m] = (...args: any[]) => { ops.push({ m, args }); return c }
      c.then = (res: any, rej: any) => Promise.resolve(h.tableResult).then(res, rej)
      return c
    },
  }),
}))
vi.mock("./moderation-service", () => ({ dismissFlag: h.dismiss, suspendSmsAccount: h.suspend, writeAuditLog: h.audit }))

import { PAGE_SIZE, parsePage, cleanQuery, listMessages, listAccounts, listFlags, actOnFlag } from "./admin-lists"

beforeEach(() => {
  h.rpcData = []; h.rpcError = null; h.rpcCalls = []; h.ops = []
  h.tableResult = { data: null, error: null }
  h.dismiss.mockReset(); h.suspend.mockReset(); h.audit.mockClear()
})

describe("parsePage / cleanQuery", () => {
  it("defaults to page 1 for junk", () => { for (const v of [null, "", "abc", "0", "-3", "1.5"]) expect(parsePage(v)).toBe(1) })
  it("parses a positive integer", () => expect(parsePage("4")).toBe(4))
  it("trims and caps the search text", () => {
    expect(cleanQuery("  hello  ")).toBe("hello")
    expect(cleanQuery("x".repeat(300))).toHaveLength(100)
    expect(cleanQuery(null)).toBe("")
  })
})

describe("listMessages", () => {
  it("passes search, status, limit and offset and returns rows + total", async () => {
    h.rpcData = [{ id: 1, message: "hi", total_count: "57" }, { id: 2, message: "yo", total_count: "57" }]
    const r = await listMessages({ q: " abc ", status: "sent", page: 3 })
    expect(h.rpcCalls[0]).toEqual({ fn: "sms_admin_messages", args: { p_q: "abc", p_status: "sent", p_limit: PAGE_SIZE, p_offset: 2 * PAGE_SIZE } })
    expect(r).toEqual({ rows: [{ id: 1, message: "hi" }, { id: 2, message: "yo" }], total: 57, page: 3, pageSize: PAGE_SIZE })
  })
  it("ignores an unknown status filter", async () => {
    await listMessages({ q: "", status: "drop table", page: 1 })
    expect(h.rpcCalls[0].args.p_status).toBe("")
  })
  it("returns total 0 for no rows", async () => expect((await listMessages({ q: "", status: "", page: 1 })).total).toBe(0))
  it("throws on an RPC error", async () => {
    h.rpcError = { message: "boom" }
    await expect(listMessages({ q: "", status: "", page: 1 })).rejects.toThrow("boom")
  })
})

describe("listAccounts / listFlags", () => {
  it("accounts: offset math and total", async () => {
    h.rpcData = [{ id: "a", total_count: 242 }]
    const r = await listAccounts({ q: "business", page: 2 })
    expect(h.rpcCalls[0]).toEqual({ fn: "sms_admin_accounts", args: { p_q: "business", p_limit: PAGE_SIZE, p_offset: PAGE_SIZE } })
    expect(r.total).toBe(242)
  })
  it("flags: only known severity/status pass through", async () => {
    await listFlags({ severity: "fraud", status: "open", page: 1 })
    await listFlags({ severity: "x", status: "y", page: 1 })
    expect(h.rpcCalls[0].args).toMatchObject({ p_severity: "fraud", p_status: "open" })
    expect(h.rpcCalls[1].args).toMatchObject({ p_severity: "", p_status: "" })
  })
})

describe("actOnFlag", () => {
  const UUID = "11111111-1111-4111-8111-111111111111"
  it("dismiss a legacy flag delegates to dismissFlag", async () => {
    h.dismiss.mockResolvedValue({ ok: true })
    expect(await actOnFlag("admin1", "legacy", "42", "dismiss")).toEqual({ ok: true })
    expect(h.dismiss).toHaveBeenCalledWith("admin1", "42")
  })
  it("dismiss a legacy flag surfaces the service error", async () => {
    h.dismiss.mockResolvedValue({ ok: false, error: "Log entry is not flagged", status: 404 })
    expect(await actOnFlag("admin1", "legacy", "42", "dismiss")).toEqual({ ok: false, error: "Log entry is not flagged" })
  })
  it("dismiss an sms_flags row updates it guarded on status=open and audits", async () => {
    h.tableResult = { data: [{ id: UUID }], error: null }
    expect(await actOnFlag("admin1", "flag", UUID, "dismiss")).toEqual({ ok: true })
    const o = h.ops[0]
    expect(o.table).toBe("sms_flags")
    expect(o.ops.find((x) => x.m === "update")!.args[0]).toMatchObject({ status: "dismissed", resolved_by: "admin1" })
    expect(o.ops.filter((x) => x.m === "eq").map((x) => x.args)).toEqual([["id", UUID], ["status", "open"]])
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_flag_dismiss", null, expect.anything(), expect.anything())
  })
  it("dismiss with no matching open row → error", async () => {
    h.tableResult = { data: [], error: null }
    expect((await actOnFlag("admin1", "flag", UUID, "dismiss")).ok).toBe(false)
  })
  it("suspend looks up the account, suspends it, then marks the flag actioned", async () => {
    h.tableResult = { data: { sms_account_id: "acct1" }, error: null }
    h.suspend.mockResolvedValue({ ok: true, newStatus: "suspended" })
    expect(await actOnFlag("admin1", "flag", UUID, "suspend")).toEqual({ ok: true })
    expect(h.suspend).toHaveBeenCalledWith("admin1", "acct1", true)
    const updates = h.ops.filter((o) => o.ops.some((x) => x.m === "update"))
    expect(updates[0].ops.find((x) => x.m === "update")!.args[0]).toMatchObject({ status: "actioned", resolved_by: "admin1" })
  })
  it("suspend failure is surfaced and the flag stays open", async () => {
    h.tableResult = { data: { sms_account_id: "acct1" }, error: null }
    h.suspend.mockResolvedValue({ ok: false, error: "SMS account not found" })
    expect(await actOnFlag("admin1", "flag", UUID, "suspend")).toEqual({ ok: false, error: "SMS account not found" })
    expect(h.ops.some((o) => o.ops.some((x) => x.m === "update"))).toBe(false)
  })
  it("rejects malformed ids, sources and actions before touching the DB", async () => {
    expect((await actOnFlag("a", "flag", "not-a-uuid", "dismiss")).ok).toBe(false)
    expect((await actOnFlag("a", "legacy", "12abc", "dismiss")).ok).toBe(false)
    expect((await actOnFlag("a", "nope" as any, "1", "dismiss")).ok).toBe(false)
    expect((await actOnFlag("a", "legacy", "1", "delete" as any)).ok).toBe(false)
    expect(h.ops).toHaveLength(0)
  })
})
