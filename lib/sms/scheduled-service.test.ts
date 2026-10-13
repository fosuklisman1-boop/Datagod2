import { describe, it, expect, vi, beforeEach } from "vitest"

type Result = { data: any; error: null | { message: string } }

const h = vi.hoisted(() => ({
  // Results queued per table, shifted in call order; the last one repeats.
  tables: {} as Record<string, Result[]>,
  ops: [] as { table: string; ops: { m: string; args: any[] }[] }[],
  rpcCalls: [] as { fn: string; args: any }[],
  // Results queued per RPC, shifted in call order; the last one repeats.
  rpcResults: {} as Record<string, (Result | Error)[]>,
  smsEnabled: true,
  notifyThrows: false,
  claim: vi.fn(),
  override: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (fn: string, args: any) => {
      h.rpcCalls.push({ fn, args })
      const q = h.rpcResults[fn] ?? []
      const r = q.length > 1 ? q.shift()! : q[0] ?? { data: null, error: null }
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
    },
    from: (table: string) => {
      if (table === "notifications" && h.notifyThrows) throw new Error("notifications down")
      const ops: { m: string; args: any[] }[] = []
      h.ops.push({ table, ops })
      const q = h.tables[table] ?? []
      const result: Result = q.length > 1 ? q.shift()! : q[0] ?? { data: null, error: null }
      const c: any = {}
      for (const m of ["select", "update", "insert", "eq", "in", "lte", "order", "limit", "maybeSingle", "single"]) {
        c[m] = (...args: any[]) => { ops.push({ m, args }); return c }
      }
      c.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej)
      return c
    },
  }),
}))
vi.mock("./kill-switch", () => ({ isSmsEnabled: () => Promise.resolve(h.smsEnabled) }))
vi.mock("./dispatch-claimed", () => ({
  DISPATCH_WINDOW_MS: 4 * 60_000,
  claimPendingForLog: h.claim,
  dispatchClaimed: h.dispatch,
}))
vi.mock("./provider-override", () => ({ fetchProviderOverrides: h.override }))
vi.mock("./moderation-service", () => ({ writeAuditLog: () => Promise.resolve() }))

import { cancelScheduledCampaign, runScheduledDispatch, SMS_OFF_LOG_INTERVAL_MS } from "./scheduled-service"

const ok = (data: any): Result => ({ data, error: null })
function opsFor(table: string) { return h.ops.filter((o) => o.table === table) }
function notificationInserts() { return opsFor("notifications").map((o) => o.ops.find((x) => x.m === "insert")?.args[0]).filter(Boolean) }
function rpcs(fn: string) { return h.rpcCalls.filter((c) => c.fn === fn) }

beforeEach(() => {
  h.tables = {}
  h.ops = []
  h.rpcCalls = []
  h.rpcResults = {}
  h.smsEnabled = true
  h.notifyThrows = false
  h.claim.mockReset().mockImplementation(async (_db: any, logId: number) => [{ id: `m${logId}`, phone: "+233241111111", message: "Hi" }])
  h.dispatch.mockReset().mockResolvedValue(1)
  h.override.mockReset().mockResolvedValue(new Map())
})

describe("cancelScheduledCampaign", () => {
  it("refuses an invalid id before touching the DB", async () => {
    expect(await cancelScheduledCampaign("acct1", "abc", "cancelled by customer")).toMatchObject({ ok: false, code: "INVALID" })
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.ops).toHaveLength(0)
  })

  it("cancels via the RPC with the caller's account, refunds, and notifies the owner", async () => {
    h.rpcResults.cancel_scheduled_sms_campaign = [ok([{ out_result: "cancelled", out_refunded: 12 }])]
    h.tables = { sms_accounts: [ok({ user_id: "owner1" })], notifications: [ok(null)] }
    const r = await cancelScheduledCampaign("acct1", "42", "cancelled by customer")
    expect(r).toEqual({ ok: true, already: false, refunded: 12 })
    expect(rpcs("cancel_scheduled_sms_campaign")[0].args).toEqual({ p_send_log_id: 42, p_account_id: "acct1", p_reason: "cancelled by customer" })
    const [n] = notificationInserts()
    expect(n).toMatchObject({ user_id: "owner1", type: "sms_scheduled_cancelled", read: false, action_url: "/dashboard/sms/records/42" })
    expect(n.message).toContain("#42")
    expect(n.message).toContain("12 credits")
  })

  it("is never blocked by the kill switch", async () => {
    h.smsEnabled = false
    h.rpcResults.cancel_scheduled_sms_campaign = [ok([{ out_result: "cancelled", out_refunded: 1 }])]
    h.tables = { sms_accounts: [ok({ user_id: "owner1" })] }
    expect(await cancelScheduledCampaign("acct1", 42, "cancelled by customer")).toEqual({ ok: true, already: false, refunded: 1 })
  })

  it("is idempotent: already_cancelled → ok, already, no refund, no notification", async () => {
    h.rpcResults.cancel_scheduled_sms_campaign = [ok([{ out_result: "already_cancelled", out_refunded: 0 }])]
    expect(await cancelScheduledCampaign("acct1", "42", "cancelled by customer")).toEqual({ ok: true, already: true, refunded: 0 })
    expect(notificationInserts()).toHaveLength(0)
  })

  it("another account's log → NOT_FOUND (the RPC returns not_found; no existence leak)", async () => {
    h.rpcResults.cancel_scheduled_sms_campaign = [ok([{ out_result: "not_found", out_refunded: 0 }])]
    expect(await cancelScheduledCampaign("other", "42", "cancelled by customer")).toMatchObject({ ok: false, code: "NOT_FOUND" })
    expect(notificationInserts()).toHaveLength(0)
  })

  it("a log that is not scheduled → NOT_SCHEDULED", async () => {
    h.rpcResults.cancel_scheduled_sms_campaign = [ok([{ out_result: "not_scheduled", out_refunded: 0 }])]
    expect(await cancelScheduledCampaign("acct1", "42", "cancelled by customer")).toMatchObject({ ok: false, code: "NOT_SCHEDULED" })
  })

  it("RPC error → DB, and an empty RPC result → NOT_FOUND", async () => {
    h.rpcResults.cancel_scheduled_sms_campaign = [{ data: null, error: { message: "boom" } }]
    expect(await cancelScheduledCampaign("acct1", "42", "x")).toMatchObject({ ok: false, code: "DB" })
    h.rpcResults.cancel_scheduled_sms_campaign = [ok([])]
    expect(await cancelScheduledCampaign("acct1", "42", "x")).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("a notification failure (error or throw) never fails the cancel", async () => {
    h.rpcResults.cancel_scheduled_sms_campaign = [ok([{ out_result: "cancelled", out_refunded: 3 }])]
    h.tables = { sms_accounts: [ok({ user_id: "owner1" })], notifications: [{ data: null, error: { message: "nope" } }] }
    expect(await cancelScheduledCampaign("acct1", "42", "cancelled by customer")).toEqual({ ok: true, already: false, refunded: 3 })
    h.notifyThrows = true
    expect(await cancelScheduledCampaign("acct1", "42", "cancelled by customer")).toEqual({ ok: true, already: false, refunded: 3 })
  })

  it("system cancel (null account) looks the owner up from the log and explains the reason", async () => {
    h.rpcResults.cancel_scheduled_sms_campaign = [ok([{ out_result: "cancelled", out_refunded: 5 }])]
    h.tables = { sms_send_logs: [ok({ sms_account_id: "acct9" })], sms_accounts: [ok({ user_id: "owner9" })], notifications: [ok(null)] }
    expect(await cancelScheduledCampaign(null, "7", "account suspended")).toEqual({ ok: true, already: false, refunded: 5 })
    expect(rpcs("cancel_scheduled_sms_campaign")[0].args).toEqual({ p_send_log_id: 7, p_account_id: null, p_reason: "account suspended" })
    const accountLookup = opsFor("sms_accounts")[0].ops
    expect(accountLookup).toContainEqual({ m: "eq", args: ["id", "acct9"] })
    const [n] = notificationInserts()
    expect(n).toMatchObject({ user_id: "owner9", type: "sms_scheduled_cancelled" })
    expect(n.message).toContain("account suspended")
  })
})

describe("runScheduledDispatch", () => {
  const FAR = () => Date.now() + 100_000

  it("kill switch off → skipped; nothing promoted, nothing cancelled", async () => {
    h.smsEnabled = false
    expect(await runScheduledDispatch({ deadlineMs: FAR() })).toEqual({ skipped: "sms_disabled" })
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.ops).toHaveLength(0)
  })

  it("kill switch off: the 'switched off' note is logged at most once per SMS_OFF_LOG_INTERVAL_MS", async () => {
    h.smsEnabled = false
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const T = Date.now() + 10 * 3_600_000 // well past any earlier note from this file
    const clock = vi.spyOn(Date, "now")
    const offNotes = () => log.mock.calls.filter((c) => String(c[0]).includes("SMS is switched off")).length
    try {
      for (const [at, expected] of [
        [T, 1], [T + 60_000, 1], [T + SMS_OFF_LOG_INTERVAL_MS - 1, 1], [T + SMS_OFF_LOG_INTERVAL_MS, 2], [T + SMS_OFF_LOG_INTERVAL_MS + 60_000, 2],
      ] as const) {
        clock.mockReturnValue(at)
        expect(await runScheduledDispatch({ deadlineMs: at + 100_000 })).toEqual({ skipped: "sms_disabled" })
        expect(offNotes()).toBe(expected)
      }
      expect(h.rpcCalls).toHaveLength(0)
      expect(h.ops).toHaveLength(0)
    } finally {
      clock.mockRestore()
      log.mockRestore()
    }
  })

  it("due → promoted (atomic RPC) → claimed → dispatched with the log's sender", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "a1" }, { id: 2, sms_account_id: "a2" }])], sms_accounts: [ok([])] }
    h.rpcResults.sms_promote_due_scheduled = [ok([
      { out_id: 1, out_account_id: "a1", out_sender_id: "SHOP1" },
      { out_id: "2", out_account_id: "a2", out_sender_id: null },
    ])]
    h.dispatch.mockResolvedValueOnce(3).mockResolvedValueOnce(2)
    const r = await runScheduledDispatch({ deadlineMs: FAR() })
    expect(r).toEqual({ promoted: 2, dispatched: 2, placed: 5, cancelled: 0, deferred: 0, errors: 0 })

    // due-log select is the same ordering/window the promote RPC uses
    const due = opsFor("sms_send_logs")[0].ops
    expect(due).toContainEqual({ m: "eq", args: ["status", "scheduled"] })
    expect(due.find((x) => x.m === "lte")!.args[0]).toBe("scheduled_for")
    expect(due).toContainEqual({ m: "limit", args: [50] })
    expect(opsFor("sms_accounts")[0].ops).toContainEqual({ m: "eq", args: ["status", "suspended"] })

    expect(rpcs("sms_promote_due_scheduled")[0].args).toEqual({ p_limit: 2 })
    expect(h.claim.mock.calls.map((c) => c[1])).toEqual([1, 2])
    expect(h.dispatch.mock.calls[0].slice(1, 4)).toEqual([1, [{ id: "m1", phone: "+233241111111", message: "Hi" }], "SHOP1"])
    expect(h.dispatch.mock.calls[1].slice(1, 4)).toEqual([2, [{ id: "m2", phone: "+233241111111", message: "Hi" }], null])
  })

  it("passes the looked-up provider override as dispatchClaimed's 6th arg", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "a1" }])], sms_accounts: [ok([])] }
    h.rpcResults.sms_promote_due_scheduled = [ok([{ out_id: 1, out_account_id: "a1", out_sender_id: "SHOP1" }])]
    h.override.mockResolvedValue(new Map([["1", "moolre"]]))
    await runScheduledDispatch({ deadlineMs: FAR() })
    expect(h.dispatch.mock.calls[0][5]).toBe("moolre")
  })

  it("override lookup failure: nothing claimed/dispatched, counted as an error (drain sends the queued log)", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "a1" }])], sms_accounts: [ok([])] }
    h.rpcResults.sms_promote_due_scheduled = [ok([{ out_id: 1, out_account_id: "a1", out_sender_id: "SHOP1" }])]
    h.override.mockRejectedValue(new Error("lookup failed"))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await runScheduledDispatch({ deadlineMs: FAR() })
    err.mockRestore()
    expect((r as { errors?: number }).errors).toBe(1)
    expect(h.claim).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it("nothing due → no promote call (an unchecked log is never promoted)", async () => {
    h.tables = { sms_send_logs: [ok([])] }
    expect(await runScheduledDispatch({ deadlineMs: FAR() })).toEqual({ promoted: 0, dispatched: 0, placed: 0, cancelled: 0, deferred: 0, errors: 0 })
    expect(rpcs("sms_promote_due_scheduled")).toHaveLength(0)
  })

  it("suspended account's due log is cancelled + refunded BEFORE promotion and excluded from the promote window", async () => {
    h.tables = {
      sms_send_logs: [ok([{ id: 1, sms_account_id: "bad" }, { id: 2, sms_account_id: "good" }]), ok({ sms_account_id: "bad" })],
      sms_accounts: [ok([{ id: "bad" }]), ok({ user_id: "ownerBad" })],
      notifications: [ok(null)],
    }
    h.rpcResults.cancel_scheduled_sms_campaign = [ok([{ out_result: "cancelled", out_refunded: 4 }])]
    h.rpcResults.sms_promote_due_scheduled = [ok([{ out_id: 2, out_account_id: "good", out_sender_id: "G" }])]
    const r = await runScheduledDispatch({ deadlineMs: FAR() })
    expect(r).toMatchObject({ promoted: 1, dispatched: 1, cancelled: 1, errors: 0 })
    const order = h.rpcCalls.map((c) => c.fn).filter((f) => f !== "mark_sms_messages_sent")
    expect(order.indexOf("cancel_scheduled_sms_campaign")).toBeLessThan(order.indexOf("sms_promote_due_scheduled"))
    expect(rpcs("cancel_scheduled_sms_campaign")[0].args).toEqual({ p_send_log_id: 1, p_account_id: null, p_reason: "account suspended" })
    expect(rpcs("sms_promote_due_scheduled")[0].args).toEqual({ p_limit: 1 })
    expect(notificationInserts()[0]).toMatchObject({ user_id: "ownerBad", type: "sms_scheduled_cancelled" })
  })

  it("a suspended log whose cancel fails is never inside the promote window", async () => {
    // order: 1 good, 2 bad (cancel fails), 3 good → promote only the 1 log ahead of the failure
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "g" }, { id: 2, sms_account_id: "bad" }, { id: 3, sms_account_id: "g" }])], sms_accounts: [ok([{ id: "bad" }])] }
    h.rpcResults.cancel_scheduled_sms_campaign = [{ data: null, error: { message: "lock timeout" } }]
    h.rpcResults.sms_promote_due_scheduled = [ok([{ out_id: 1, out_account_id: "g", out_sender_id: null }])]
    const r = await runScheduledDispatch({ deadlineMs: FAR() })
    expect(rpcs("sms_promote_due_scheduled")[0].args).toEqual({ p_limit: 1 })
    expect(r).toMatchObject({ promoted: 1, cancelled: 0, errors: 1 })
  })

  it("a failed cancel at the head of the queue means no promotion this tick", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 2, sms_account_id: "bad" }, { id: 3, sms_account_id: "g" }])], sms_accounts: [ok([{ id: "bad" }])] }
    h.rpcResults.cancel_scheduled_sms_campaign = [new Error("network")]
    const r = await runScheduledDispatch({ deadlineMs: FAR() })
    expect(rpcs("sms_promote_due_scheduled")).toHaveLength(0)
    expect(r).toMatchObject({ promoted: 0, errors: 1 })
  })

  it("the suspension lookup failing → no promotion this tick (fail safe)", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "a" }])], sms_accounts: [{ data: null, error: { message: "down" } }] }
    const r = await runScheduledDispatch({ deadlineMs: FAR() })
    expect(rpcs("sms_promote_due_scheduled")).toHaveLength(0)
    expect(r).toMatchObject({ promoted: 0, errors: 1 })
  })

  it("the due-log select failing → no promotion, error counted", async () => {
    h.tables = { sms_send_logs: [{ data: null, error: { message: "down" } }] }
    const r = await runScheduledDispatch({ deadlineMs: FAR() })
    expect(rpcs("sms_promote_due_scheduled")).toHaveLength(0)
    expect(r).toMatchObject({ promoted: 0, errors: 1 })
  })

  it("concurrent run already promoted everything → the RPC returns none, nothing dispatched", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "a" }])], sms_accounts: [ok([])] }
    h.rpcResults.sms_promote_due_scheduled = [ok([])]
    expect(await runScheduledDispatch({ deadlineMs: FAR() })).toEqual({ promoted: 0, dispatched: 0, placed: 0, cancelled: 0, deferred: 0, errors: 0 })
    expect(h.claim).not.toHaveBeenCalled()
  })

  it("promote RPC error → error counted, nothing dispatched", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "a" }])], sms_accounts: [ok([])] }
    h.rpcResults.sms_promote_due_scheduled = [{ data: null, error: { message: "boom" } }]
    expect(await runScheduledDispatch({ deadlineMs: FAR() })).toMatchObject({ promoted: 0, dispatched: 0, errors: 1 })
    expect(h.claim).not.toHaveBeenCalled()
  })

  it("past the deadline: promoted logs are not started (they stay queued for the drain)", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "a" }, { id: 2, sms_account_id: "a" }])], sms_accounts: [ok([])] }
    h.rpcResults.sms_promote_due_scheduled = [ok([
      { out_id: 1, out_account_id: "a", out_sender_id: null },
      { out_id: 2, out_account_id: "a", out_sender_id: null },
    ])]
    let now = 1_000_000
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now)
    h.dispatch.mockImplementation(async () => { now += 60_000; return 1 })
    try {
      const r = await runScheduledDispatch({ deadlineMs: 1_000_000 + 30_000 })
      expect(r).toMatchObject({ promoted: 2, dispatched: 1, deferred: 1, errors: 0 })
      expect(h.claim).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("caps each dispatch window at the hard deadline", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "a" }])], sms_accounts: [ok([])] }
    h.rpcResults.sms_promote_due_scheduled = [ok([{ out_id: 1, out_account_id: "a", out_sender_id: null }])]
    const spy = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    try {
      await runScheduledDispatch({ deadlineMs: 1_100_000, hardDeadlineMs: 1_000_000 + 60_000 })
      // claimedAtMs + 4 min must not pass the hard deadline
      expect(h.dispatch.mock.calls[0][4]).toBe(1_000_000 + 60_000 - 4 * 60_000)
    } finally {
      spy.mockRestore()
    }
    h.dispatch.mockClear()
    await runScheduledDispatch({ deadlineMs: FAR() })
    expect(typeof h.dispatch.mock.calls[0][4]).toBe("number")
  })

  it("a throw inside one log never stops the others (the failed log stays queued for the drain)", async () => {
    h.tables = { sms_send_logs: [ok([{ id: 1, sms_account_id: "a" }, { id: 2, sms_account_id: "a" }])], sms_accounts: [ok([])] }
    h.rpcResults.sms_promote_due_scheduled = [ok([
      { out_id: 1, out_account_id: "a", out_sender_id: null },
      { out_id: 2, out_account_id: "a", out_sender_id: null },
    ])]
    h.claim.mockRejectedValueOnce(new Error("claim exploded"))
    const r = await runScheduledDispatch({ deadlineMs: FAR() })
    expect(r).toMatchObject({ promoted: 2, dispatched: 1, placed: 1, errors: 1 })
    expect(h.dispatch).toHaveBeenCalledTimes(1)
    expect(h.dispatch.mock.calls[0][1]).toBe(2)
    // no status write that would take the failed log out of 'queued'
    expect(opsFor("sms_send_logs").filter((o) => o.ops.some((x) => x.m === "update"))).toHaveLength(0)
  })

  it("respects a custom limit", async () => {
    h.tables = { sms_send_logs: [ok([])] }
    await runScheduledDispatch({ limit: 10, deadlineMs: FAR() })
    expect(opsFor("sms_send_logs")[0].ops).toContainEqual({ m: "limit", args: [10] })
  })
})
