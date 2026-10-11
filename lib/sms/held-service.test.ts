import { describe, it, expect, vi, beforeEach } from "vitest"

type Result = { data: any; error: null | { message: string } }

const h = vi.hoisted(() => ({
  // Results queued per table, shifted in call order; the last one repeats.
  tables: {} as Record<string, Result[]>,
  ops: [] as { table: string; ops: { m: string; args: any[] }[] }[],
  rpcCalls: [] as { fn: string; args: any }[],
  rpcResults: {} as Record<string, Result>,
  smsEnabled: true,
  notifyThrows: false,
  dispatch: vi.fn(),
  audit: vi.fn((..._a: any[]) => Promise.resolve()),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (fn: string, args: any) => {
      h.rpcCalls.push({ fn, args })
      return Promise.resolve(h.rpcResults[fn] ?? { data: null, error: null })
    },
    from: (table: string) => {
      if (table === "notifications" && h.notifyThrows) throw new Error("notifications down")
      const ops: { m: string; args: any[] }[] = []
      h.ops.push({ table, ops })
      const q = h.tables[table] ?? []
      const result: Result = q.length > 1 ? q.shift()! : q[0] ?? { data: null, error: null }
      const c: any = {}
      for (const m of ["select", "update", "insert", "eq", "in", "not", "order", "limit", "maybeSingle", "single"]) {
        c[m] = (...args: any[]) => { ops.push({ m, args }); return c }
      }
      c.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej)
      return c
    },
  }),
}))
vi.mock("./kill-switch", () => ({ isSmsEnabled: () => Promise.resolve(h.smsEnabled) }))
vi.mock("./campaign-dispatch", () => ({ dispatchCampaign: h.dispatch }))
vi.mock("./moderation-service", () => ({ writeAuditLog: h.audit }))

import { parseLogId, rejectHeldCampaign, releaseHeldCampaign } from "./held-service"

const HELD_LOG = { id: 42, sms_account_id: "acct1", status: "held", sender_id: "MYSHOP", policy_shadow: { decision: "hold", code: "REVIEW_HOLD" } }
const OWNER: Result = { data: { user_id: "owner1" }, error: null }

function opsFor(table: string) { return h.ops.filter((o) => o.table === table) }
function updates(table: string) { return opsFor(table).filter((o) => o.ops.some((x) => x.m === "update")) }
function patchOf(o: { ops: { m: string; args: any[] }[] }) { return o.ops.find((x) => x.m === "update")!.args[0] }
function eqs(o: { ops: { m: string; args: any[] }[] }) { return o.ops.filter((x) => x.m === "eq").map((x) => x.args) }
function notificationInserts() { return opsFor("notifications").map((o) => o.ops.find((x) => x.m === "insert")?.args[0]).filter(Boolean) }

beforeEach(() => {
  h.tables = {}
  h.ops = []
  h.rpcCalls = []
  h.rpcResults = {}
  h.smsEnabled = true
  h.notifyThrows = false
  h.dispatch.mockReset()
  h.audit.mockClear()
})

describe("parseLogId", () => {
  it("accepts positive integers (string or number)", () => {
    expect(parseLogId("42")).toBe(42)
    expect(parseLogId(7)).toBe(7)
  })
  it("rejects junk", () => {
    for (const v of ["", "0", "-1", "1.5", "abc", "12abc", "held:3", null, undefined, 0, -4, 2.5, "99999999999999999999"]) {
      expect(parseLogId(v as any)).toBeNull()
    }
  })
})

describe("releaseHeldCampaign", () => {
  function heldScenario() {
    h.tables = {
      sms_send_logs: [{ data: HELD_LOG, error: null }, { data: [{ id: 42 }], error: null }, { data: null, error: null }],
      sms_messages: [
        { data: [{ id: "m1", phone: "+233241111111", rendered_message: "Hello" }, { id: "m2", phone: "+233242222222", rendered_message: "Hello" }], error: null },
        { data: null, error: null },
      ],
      sms_accounts: [OWNER],
      notifications: [{ data: null, error: null }],
    }
    h.dispatch.mockImplementation(async (items: any[], _sender: any, mark: any) => {
      await mark("hubtel", [{ id: items[0].id, mid: "mid1", bid: "b1" }], { unconfirmed: false })
      return { provider: "hubtel", sent: [{ id: items[0].id, mid: "mid1", bid: "b1" }], fallbackSent: [], outOfFunds: false }
    })
  }

  describe("a held SCHEDULED send", () => {
    const FUTURE = new Date(Date.now() + 3 * 86_400_000)
    FUTURE.setUTCHours(9, 5, 0, 0)
    const FUTURE_ISO = FUTURE.toISOString()

    it("future scheduled_for → held→scheduled, no claim or dispatch, notifies with the send time", async () => {
      h.tables = {
        sms_send_logs: [{ data: { ...HELD_LOG, scheduled_for: FUTURE_ISO }, error: null }, { data: [{ id: 42 }], error: null }],
        sms_accounts: [OWNER],
        notifications: [{ data: null, error: null }],
      }
      const r = await releaseHeldCampaign("admin1", "42")
      expect(r).toEqual({ ok: true, already: false, placed: 0, scheduled: true, scheduledFor: FUTURE_ISO })

      const [flip] = updates("sms_send_logs")
      expect(patchOf(flip)).toMatchObject({ status: "scheduled" })
      expect(patchOf(flip).policy_shadow).toMatchObject({ decision: "hold", review: { outcome: "released", by: "admin1" } })
      expect(eqs(flip)).toEqual([["id", 42], ["status", "held"]])
      expect(updates("sms_send_logs")).toHaveLength(1)
      expect(updates("sms_messages")).toHaveLength(0)
      expect(h.dispatch).not.toHaveBeenCalled()
      expect(h.rpcCalls.some((c) => c.fn === "recompute_sms_send_result")).toBe(false)

      const [n] = notificationInserts()
      expect(n.message).toMatch(/approved/i)
      expect(n.message).toContain(`${String(FUTURE.getUTCHours()).padStart(2, "0")}:05 GMT`)
      expect(h.audit).toHaveBeenCalledWith("admin1", "sms_held_release", "owner1", { logId: 42, status: "held" }, { status: "scheduled", scheduledFor: FUTURE_ISO })
    })

    it("double release of a scheduled-approved log is a no-op", async () => {
      h.tables = { sms_send_logs: [{ data: { ...HELD_LOG, status: "scheduled", scheduled_for: FUTURE_ISO, policy_shadow: { review: { outcome: "released" } } }, error: null }] }
      expect(await releaseHeldCampaign("admin1", "42")).toEqual({ ok: true, already: true, status: "scheduled" })
      expect(updates("sms_send_logs")).toHaveLength(0)
      expect(notificationInserts()).toHaveLength(0)
    })

    it("a scheduled log that was never held → NOT_HELD", async () => {
      h.tables = { sms_send_logs: [{ data: { ...HELD_LOG, status: "scheduled", scheduled_for: FUTURE_ISO, policy_shadow: null }, error: null }] }
      expect(await releaseHeldCampaign("admin1", "42")).toMatchObject({ ok: false, code: "NOT_HELD" })
    })

    it("past scheduled_for → today's behaviour (queued + dispatched now)", async () => {
      heldScenario()
      h.tables.sms_send_logs[0] = { data: { ...HELD_LOG, scheduled_for: new Date(Date.now() - 60_000).toISOString() }, error: null }
      expect(await releaseHeldCampaign("admin1", "42")).toEqual({ ok: true, already: false, placed: 1 })
      expect(patchOf(updates("sms_send_logs")[0])).toMatchObject({ status: "queued" })
      expect(h.dispatch).toHaveBeenCalledTimes(1)
    })

    it("null scheduled_for → today's behaviour", async () => {
      heldScenario()
      h.tables.sms_send_logs[0] = { data: { ...HELD_LOG, scheduled_for: null }, error: null }
      expect(await releaseHeldCampaign("admin1", "42")).toEqual({ ok: true, already: false, placed: 1 })
      expect(h.dispatch).toHaveBeenCalledTimes(1)
    })
  })

  it("refuses an invalid id before touching the DB", async () => {
    const r = await releaseHeldCampaign("admin1", "abc")
    expect(r).toMatchObject({ ok: false, code: "INVALID" })
    expect(h.ops).toHaveLength(0)
  })

  it("404s an unknown log", async () => {
    h.tables = { sms_send_logs: [{ data: null, error: null }] }
    expect(await releaseHeldCampaign("admin1", "42")).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("flips held→queued conditionally, claims pending messages, dispatches, releases unplaced rows and recomputes", async () => {
    heldScenario()
    const r = await releaseHeldCampaign("admin1", "42")
    expect(r).toEqual({ ok: true, already: false, placed: 1 })

    const logUpdates = updates("sms_send_logs")
    expect(patchOf(logUpdates[0])).toMatchObject({ status: "queued" })
    expect(patchOf(logUpdates[0]).policy_shadow).toMatchObject({ decision: "hold", review: { outcome: "released", by: "admin1" } })
    expect(eqs(logUpdates[0])).toEqual([["id", 42], ["status", "held"]])

    const msgUpdates = updates("sms_messages")
    expect(patchOf(msgUpdates[0])).toMatchObject({ status: "claimed" })
    expect(eqs(msgUpdates[0])).toEqual([["send_log_id", 42], ["status", "pending"]])
    // hand-back of rows dispatch did not place — scoped to the rows THIS call claimed
    expect(patchOf(msgUpdates[1])).toEqual({ status: "pending", claimed_at: null })
    expect(eqs(msgUpdates[1])).toEqual([["send_log_id", 42], ["status", "claimed"]])
    expect(msgUpdates[1].ops.find((x) => x.m === "in")!.args).toEqual(["id", ["m1", "m2"]])
    expect(msgUpdates).toHaveLength(2)

    expect(h.dispatch).toHaveBeenCalledTimes(1)
    const [items, sender] = h.dispatch.mock.calls[0]
    expect(items).toEqual([
      { id: "m1", phone: "+233241111111", message: "Hello" },
      { id: "m2", phone: "+233242222222", message: "Hello" },
    ])
    expect(sender).toBe("MYSHOP")

    expect(h.rpcCalls.find((c) => c.fn === "mark_sms_messages_sent")!.args).toEqual({ p_provider: "hubtel", p_rows: [{ id: "m1", mid: "mid1", bid: "b1" }] })
    expect(h.rpcCalls.find((c) => c.fn === "recompute_sms_send_result")!.args).toEqual({ p_send_log_id: 42, max_attempts: 3 })
    // first provider batch id recorded on the log
    expect(patchOf(logUpdates[1])).toEqual({ provider_batch_id: "b1", provider: "hubtel" })
  })

  it("never resets rows the cron drain claimed (not in this call's items)", async () => {
    heldScenario()
    // This call claimed only m1; the drain holds m9 of the same log (claimed, mid-send).
    h.tables.sms_messages = [{ data: [{ id: "m1", phone: "+233241111111", rendered_message: "Hello" }], error: null }, { data: null, error: null }]
    h.dispatch.mockResolvedValue({ provider: "hubtel", sent: [], fallbackSent: [], outOfFunds: false })
    await releaseHeldCampaign("admin1", "42")
    const handBack = updates("sms_messages")[1]
    expect(handBack.ops.find((x) => x.m === "in")!.args).toEqual(["id", ["m1"]])
    expect(JSON.stringify(handBack.ops)).not.toContain("m9")
  })

  it("hand-back is chunked (100 ids per update) and excludes placed-but-unmarked rows", async () => {
    heldScenario()
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, phone: "+233241111111", rendered_message: "Hi" }))
    h.tables.sms_messages = [{ data: rows, error: null }, { data: null, error: { message: "fallback down" } }, { data: null, error: null }]
    h.rpcResults.mark_sms_messages_sent = { data: null, error: { message: "rpc down" } }
    h.dispatch.mockImplementation(async (_items: any[], _s: any, mark: any) => {
      await mark("moolre", [{ id: "m0", mid: null, bid: null }], { unconfirmed: false })
      return { provider: "moolre", sent: [{ id: "m0", mid: null, bid: null }], fallbackSent: [], outOfFunds: false }
    })
    await releaseHeldCampaign("admin1", "42")
    const handBacks = updates("sms_messages").filter((o) => patchOf(o).status === "pending")
    const ids = handBacks.map((o) => o.ops.find((x) => x.m === "in")!.args[1] as string[])
    expect(ids.map((a) => a.length)).toEqual([100, 100, 49])
    expect(ids.flat()).not.toContain("m0")
  }, 10_000)

  it("notifies the customer in-app and audits sms_held_release", async () => {
    heldScenario()
    await releaseHeldCampaign("admin1", "42")
    const [n] = notificationInserts()
    expect(n).toMatchObject({ user_id: "owner1", type: "sms_campaign_review", read: false, action_url: "/dashboard/sms/records/42" })
    expect(n.message).toMatch(/approved/i)
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_held_release", "owner1", { logId: 42, status: "held" }, { status: "queued", placed: 1 })
  })

  it("refuses while SMS is switched off — nothing changes", async () => {
    heldScenario()
    h.smsEnabled = false
    const r = await releaseHeldCampaign("admin1", "42")
    expect(r).toMatchObject({ ok: false, code: "SMS_DISABLED" })
    expect((r as any).error).toMatch(/turn sms back on/i)
    expect(updates("sms_send_logs")).toHaveLength(0)
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it("second release is a no-op ({ok, already}) — no dispatch, notification or audit", async () => {
    h.tables = { sms_send_logs: [{ data: { ...HELD_LOG, status: "sending", policy_shadow: { review: { outcome: "released" } } }, error: null }] }
    expect(await releaseHeldCampaign("admin1", "42")).toEqual({ ok: true, already: true, status: "sending" })
    expect(updates("sms_send_logs")).toHaveLength(0)
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(notificationInserts()).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("no-op even when SMS is off (already released)", async () => {
    h.smsEnabled = false
    h.tables = { sms_send_logs: [{ data: { ...HELD_LOG, status: "sent" }, error: null }] }
    expect(await releaseHeldCampaign("admin1", "42")).toEqual({ ok: true, already: true, status: "sent" })
  })

  it("refuses to release a rejected campaign", async () => {
    h.tables = { sms_send_logs: [{ data: { ...HELD_LOG, status: "failed", policy_shadow: { review: { outcome: "rejected" } } }, error: null }] }
    expect(await releaseHeldCampaign("admin1", "42")).toMatchObject({ ok: false, code: "REJECTED" })
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it("a failed log counts as already released only when it was released", async () => {
    h.tables = { sms_send_logs: [{ data: { ...HELD_LOG, status: "failed", policy_shadow: { review: { outcome: "released" } } }, error: null }] }
    expect(await releaseHeldCampaign("admin1", "42")).toEqual({ ok: true, already: true, status: "failed" })
  })

  it("an orphan log closed as failed by enqueueSend (never released) → NOT_HELD", async () => {
    h.tables = { sms_send_logs: [{ data: { ...HELD_LOG, status: "failed", policy_shadow: { decision: "hold" } }, error: null }] }
    expect(await releaseHeldCampaign("admin1", "42")).toMatchObject({ ok: false, code: "NOT_HELD" })
    h.tables = { sms_send_logs: [{ data: { ...HELD_LOG, status: "failed", policy_shadow: null }, error: null }] }
    expect(await releaseHeldCampaign("admin1", "42")).toMatchObject({ ok: false, code: "NOT_HELD" })
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it("refuses statuses that were never held (blocked)", async () => {
    h.tables = { sms_send_logs: [{ data: { ...HELD_LOG, status: "blocked", policy_shadow: null }, error: null }] }
    expect(await releaseHeldCampaign("admin1", "42")).toMatchObject({ ok: false, code: "NOT_HELD" })
  })

  it("lost the race (conditional flip matched 0 rows) → re-reads and reports already", async () => {
    h.tables = {
      sms_send_logs: [
        { data: HELD_LOG, error: null },
        { data: [], error: null },
        { data: { ...HELD_LOG, status: "queued" }, error: null },
      ],
    }
    expect(await releaseHeldCampaign("admin1", "42")).toEqual({ ok: true, already: true, status: "queued" })
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("a dispatch throw still releases claimed rows and recomputes (drain finishes the send)", async () => {
    heldScenario()
    h.dispatch.mockRejectedValue(new Error("provider down"))
    const r = await releaseHeldCampaign("admin1", "42")
    expect(r).toEqual({ ok: true, already: false, placed: 0 })
    expect(patchOf(updates("sms_messages")[1])).toEqual({ status: "pending", claimed_at: null })
    expect(h.rpcCalls.some((c) => c.fn === "recompute_sms_send_result")).toBe(true)
  })

  it("a failed claim leaves rows pending for the drain (log is queued) and still succeeds", async () => {
    heldScenario()
    h.tables.sms_messages = [{ data: null, error: { message: "timeout" } }, { data: null, error: null }]
    const r = await releaseHeldCampaign("admin1", "42")
    expect(r).toEqual({ ok: true, already: false, placed: 0 })
    expect(h.dispatch).not.toHaveBeenCalled()
    // nothing claimed by this call → no hand-back update at all (only the failed claim)
    expect(updates("sms_messages")).toHaveLength(1)
  })

  it("notification failure is fail-soft", async () => {
    heldScenario()
    h.notifyThrows = true
    expect(await releaseHeldCampaign("admin1", "42")).toEqual({ ok: true, already: false, placed: 1 })
    expect(h.audit).toHaveBeenCalled()
  })

  it("lookup error → DB error", async () => {
    h.tables = { sms_send_logs: [{ data: null, error: { message: "boom" } }] }
    expect(await releaseHeldCampaign("admin1", "42")).toMatchObject({ ok: false, code: "DB" })
  })
})

describe("rejectHeldCampaign", () => {
  const REJECTED: Result = {
    data: [{ out_outcome: "rejected", out_status: "failed", out_account_id: "acct1", out_refunded_messages: 5, out_refunded_credits: 10 }],
    error: null,
  }
  beforeEach(() => {
    h.tables = { sms_accounts: [OWNER], notifications: [{ data: null, error: null }] }
  })

  it("requires a reason of at least 3 characters", async () => {
    for (const reason of ["", "  ", "ab", undefined as any]) {
      expect(await rejectHeldCampaign("admin1", "42", reason)).toMatchObject({ ok: false, code: "INVALID" })
    }
    expect(h.rpcCalls).toHaveLength(0)
  })

  it("refuses an invalid id", async () => {
    expect(await rejectHeldCampaign("admin1", "0", "spam content")).toMatchObject({ ok: false, code: "INVALID" })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it("calls the atomic reject RPC and returns the refunded totals", async () => {
    h.rpcResults.reject_held_sms_campaign = REJECTED
    const r = await rejectHeldCampaign("admin1", "42", "  looks like phishing  ")
    expect(h.rpcCalls[0]).toEqual({ fn: "reject_held_sms_campaign", args: { p_send_log_id: 42, p_reason: "looks like phishing", p_admin_id: "admin1" } })
    expect(r).toEqual({ ok: true, already: false, refundedCredits: 10, refundedMessages: 5 })
  })

  it("notifies the customer with the refunded credits and the reason, and audits sms_held_reject", async () => {
    h.rpcResults.reject_held_sms_campaign = REJECTED
    await rejectHeldCampaign("admin1", "42", "looks like phishing")
    const [n] = notificationInserts()
    expect(n).toMatchObject({ user_id: "owner1", type: "sms_campaign_review", action_url: "/dashboard/sms/records/42" })
    expect(n.message).toContain("10 credits")
    expect(n.message).toContain("looks like phishing")
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_held_reject", "owner1", { logId: 42, status: "held" },
      { status: "failed", reason: "looks like phishing", refundedCredits: 10, refundedMessages: 5 })
  })

  it("is never blocked by the kill switch", async () => {
    h.smsEnabled = false
    h.rpcResults.reject_held_sms_campaign = REJECTED
    expect(await rejectHeldCampaign("admin1", "42", "spam")).toMatchObject({ ok: true, refundedCredits: 10 })
  })

  it("second reject is a no-op — no notification, no audit", async () => {
    h.rpcResults.reject_held_sms_campaign = { data: [{ out_outcome: "already_rejected", out_status: "failed", out_account_id: "acct1", out_refunded_messages: 0, out_refunded_credits: 0 }], error: null }
    expect(await rejectHeldCampaign("admin1", "42", "spam")).toEqual({ ok: true, already: true, refundedCredits: 0, refundedMessages: 0 })
    expect(notificationInserts()).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("refuses a campaign that is no longer held", async () => {
    h.rpcResults.reject_held_sms_campaign = { data: [{ out_outcome: "not_held", out_status: "sending", out_account_id: "acct1" }], error: null }
    const r = await rejectHeldCampaign("admin1", "42", "spam")
    expect(r).toMatchObject({ ok: false, code: "NOT_HELD" })
    expect((r as any).error).toContain("sending")
  })

  it("404s an unknown log", async () => {
    h.rpcResults.reject_held_sms_campaign = { data: [{ out_outcome: "not_found" }], error: null }
    expect(await rejectHeldCampaign("admin1", "42", "spam")).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("RPC error → DB error, nothing notified", async () => {
    h.rpcResults.reject_held_sms_campaign = { data: null, error: { message: "function does not exist" } }
    expect(await rejectHeldCampaign("admin1", "42", "spam")).toMatchObject({ ok: false, code: "DB" })
    expect(notificationInserts()).toHaveLength(0)
  })

  it("notification failure is fail-soft", async () => {
    h.rpcResults.reject_held_sms_campaign = REJECTED
    h.notifyThrows = true
    expect(await rejectHeldCampaign("admin1", "42", "spam")).toMatchObject({ ok: true, refundedCredits: 10 })
    expect(h.audit).toHaveBeenCalled()
  })

  it("a zero-credit refund is reported without a credits line", async () => {
    h.rpcResults.reject_held_sms_campaign = { data: [{ out_outcome: "rejected", out_status: "failed", out_account_id: "acct1", out_refunded_messages: 0, out_refunded_credits: 0 }], error: null }
    await rejectHeldCampaign("admin1", "42", "spam")
    expect(notificationInserts()[0].message).not.toMatch(/credits? (have|has) been refunded/)
  })
})
