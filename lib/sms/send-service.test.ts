import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.hoisted — must exist before any module under test imports supabase at module level.
const h = vi.hoisted(() => {
  type Call = { fn: string; table?: string; args?: any }

  const state = {
    calls: [] as Call[],
    debitError: null as null | string,  // if set, rpc("debit_sms_for_send") returns this error
    insertLogId: "log-1",               // id returned from sms_send_logs insert
    insertLogError: null as null | string,
    insertMsgError: null as null | string,
    // Drives the mocked ./policy-context sender resolver: null → no row; only
    // local_status === "active" resolves.
    senderRow: { local_status: "active" } as { local_status: string } | null,
    bulkOk: true,                        // dispatchCampaign places the rows
    dispatchProvider: "moolre" as string, // provider the mocked dispatch reports
    unconfirmed: false,                  // hubtel rows placed with no ids ("unknown" outcome)
    dispatchThrows: false,
    msgUpdates: [] as { patch: any; ids: string[] }[], // captured .update().in() (mark-sent)
    msgIdSeq: 0,                         // id generator for inserted sms_messages
  }

  const fake = {
    rpc: (fn: string, args?: any) => {
      state.calls.push({ fn, args })
      if (fn === "debit_sms_for_send") {
        if (state.debitError) {
          return Promise.resolve({ data: null, error: { message: state.debitError } })
        }
        return Promise.resolve({ data: null, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => {
      state.calls.push({ fn: "from", table })
      const insertChain = {
        select: () => ({
          single: () => {
            if (table === "sms_send_logs") {
              if (state.insertLogError) {
                return Promise.resolve({ data: null, error: { message: state.insertLogError } })
              }
              return Promise.resolve({ data: { id: state.insertLogId }, error: null })
            }
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }

      return {
        insert: (rows: any) => {
          state.calls.push({ fn: "insert", table, args: rows })
          if (table === "sms_send_logs") return insertChain
          // sms_messages: .insert(rows).select("id, phone") → return generated ids.
          if (table === "sms_messages") {
            return {
              select: (_cols?: string) => {
                if (state.insertMsgError) return Promise.resolve({ data: null, error: { message: state.insertMsgError } })
                const arr = Array.isArray(rows) ? rows : [rows]
                const data = arr.map((r: any) => ({ id: `m${state.msgIdSeq++}`, phone: r.phone }))
                return Promise.resolve({ data, error: null })
              },
            }
          }
          if (state.insertMsgError) return Promise.resolve({ data: null, error: { message: state.insertMsgError } })
          return Promise.resolve({ data: null, error: null })
        },
        update: (patch: any) => ({
          eq: () => ({ lt: () => Promise.resolve({ data: null, error: null }) }),
          // mark-sent: .update({status:'sent',...}).in("id", ids)
          in: (_col: string, ids: string[]) => {
            state.msgUpdates.push({ patch, ids })
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
    },
  }

  return { state, fake }
})

// Mock supabase — must happen before the module under test is imported
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

// Mock the instant dispatch (routing + providers are tested in campaign-dispatch.test.ts).
// Mirrors the real contract: onChunkSent is awaited per placed chunk.
vi.mock("./campaign-dispatch", () => ({
  dispatchCampaign: async (
    its: { id: string }[],
    senderId: string | null,
    onChunkSent?: (provider: string, rows: { id: string; mid: string | null; bid: string | null }[]) => Promise<void>,
  ) => {
    h.state.calls.push({ fn: "bulk", args: { count: its.length, senderId: senderId ?? undefined } })
    if (h.state.dispatchThrows) throw new Error("dispatch boom")
    const sent = h.state.bulkOk
      ? its.map((i) => ({ id: i.id, mid: h.state.dispatchProvider === "hubtel" && !h.state.unconfirmed ? `hm-${i.id}` : null, bid: h.state.dispatchProvider === "hubtel" && !h.state.unconfirmed ? "B1" : null }))
      : []
    if (onChunkSent && sent.length) await onChunkSent(h.state.dispatchProvider, sent)
    return { provider: h.state.dispatchProvider, sent, fallbackSent: [], unconfirmed: [], outOfFunds: false }
  },
}))

// Sender resolution + policy shadow live in ./policy-context (tested separately);
// h.state.senderRow keeps driving which senders resolve.
vi.mock("./policy-context", () => ({
  resolveCampaignSender: (_acct: string, sid?: string | null) => {
    const s = (sid ?? "").trim().toUpperCase()
    if (!s) return Promise.resolve({ kind: "platform", name: null, kycFree: false })
    const row = h.state.senderRow
    return Promise.resolve(row && row.local_status === "active" ? { kind: "own", name: s, kycFree: true } : null)
  },
  shadowPolicyWithin: () => Promise.resolve({ mode: "platform", shadow: { decision: "allow", code: "OK", reason: "", flags: [], enforced: false, evaluated_at: "t" } }),
}))

import { enqueueSend } from "./send-service"

beforeEach(() => {
  h.state.calls.length = 0
  h.state.debitError = null
  h.state.insertLogId = "log-1"
  h.state.insertLogError = null
  h.state.insertMsgError = null
  h.state.senderRow = { local_status: "active" }
  h.state.bulkOk = true
  h.state.dispatchProvider = "moolre"
  h.state.unconfirmed = false
  h.state.dispatchThrows = false
  h.state.msgUpdates.length = 0
  h.state.msgIdSeq = 0
})

// Helper: all rpc calls
const rpcs = () => h.state.calls.filter((c) => c.fn !== "from" && c.fn !== "insert")
// Helper: all inserts by table
const inserts = (table: string) =>
  h.state.calls.filter((c) => c.fn === "insert" && c.table === table)

describe("enqueueSend", () => {
  it("blocked message → inserts log with status=blocked, no debit, ok:false", async () => {
    // "you have won" triggers the prize/lottery block rule
    const result = await enqueueSend("u1", "acc1", "Congratulations, you have won a prize!", ["0241234567"])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe("BLOCKED")
      expect(result.reason).toBeTruthy()
    }
    // no debit_sms_for_send called
    expect(rpcs().map((c) => c.fn)).not.toContain("debit_sms_for_send")
    // sms_send_logs inserted with status=blocked
    const logInserts = inserts("sms_send_logs")
    expect(logInserts.length).toBeGreaterThanOrEqual(1)
    const logRow = Array.isArray(logInserts[0].args) ? logInserts[0].args[0] : logInserts[0].args
    expect(logRow.status).toBe("blocked")
    expect(logRow.credits_reserved).toBe(0)
    // no sms_messages inserted
    expect(inserts("sms_messages")).toHaveLength(0)
  })

  it("TOO_MANY_RECIPIENTS → ok:false, no debit, no log", async () => {
    const recipients = Array.from({ length: 501 }, (_, i) => `024${String(i).padStart(7, "0")}`)
    const result = await enqueueSend("u1", "acc1", "Hello everyone!", recipients)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("TOO_MANY_RECIPIENTS")
    expect(rpcs().map((c) => c.fn)).not.toContain("debit_sms_for_send")
  })

  it("INSUFFICIENT_CREDITS from RPC → ok:false, no sms_messages inserted", async () => {
    h.state.debitError = "INSUFFICIENT_CREDITS"
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("INSUFFICIENT_CREDITS")
    // debit was attempted
    expect(rpcs().some((c) => c.fn === "debit_sms_for_send")).toBe(true)
    // no sms_messages inserted
    expect(inserts("sms_messages")).toHaveLength(0)
  })

  it("NOT_ACTIVATED from RPC → ok:false", async () => {
    h.state.debitError = "NOT_ACTIVATED"
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("NOT_ACTIVATED")
    expect(inserts("sms_messages")).toHaveLength(0)
  })

  it("SUSPENDED from RPC → ok:false", async () => {
    h.state.debitError = "SUSPENDED"
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("SUSPENDED")
    expect(inserts("sms_messages")).toHaveLength(0)
  })

  it("success → debit called with seg*recipients, N sms_messages inserted, ok:true", async () => {
    const recipients = ["0241234567", "0551234567", "0201234567"]
    const result = await enqueueSend("u1", "acc1", "Hello world", recipients)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sendLogId).toBe("log-1")
      expect(result.total).toBe(3)
      expect(result.segments).toBeGreaterThanOrEqual(1)
      expect(result.creditsReserved).toBe(result.segments * recipients.length)
    }
    // debit called with correct credits
    const debitCall = rpcs().find((c) => c.fn === "debit_sms_for_send")
    expect(debitCall).toBeTruthy()
    expect(debitCall!.args.p_account_id).toBe("acc1")
    expect(debitCall!.args.p_credits).toBeGreaterThan(0)
    // sms_messages inserted for each valid recipient
    const msgInserts = inserts("sms_messages")
    // All 3 recipients are valid Ghanaian numbers
    expect(msgInserts.length).toBeGreaterThan(0)
  })

  const dispatches = () => h.state.calls.filter((c) => c.fn === "bulk")
  const marks = () => h.state.calls.filter((c) => c.fn === "mark_sms_messages_sent")

  it("INSTANT dispatch: accepted rows are marked sent via mark_sms_messages_sent", async () => {
    const recipients = ["0241234567", "0551234567", "0201234567"]
    const result = await enqueueSend("u1", "acc1", "Hello world", recipients)
    expect(result.ok).toBe(true)
    expect(dispatches()).toHaveLength(1)
    expect(marks()).toHaveLength(1)
    expect(marks()[0].args.p_provider).toBe("moolre")
    expect(marks()[0].args.p_rows.map((r: { id: string }) => r.id)).toEqual(["m0", "m1", "m2"])
    // Parent status recomputed after the dispatch.
    expect(rpcs().some((c) => c.fn === "recompute_sms_send_result")).toBe(true)
  })

  it("dispatch placing nothing leaves rows 'pending' for the cron (no mark-sent), still ok:true", async () => {
    h.state.bulkOk = false
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567", "0551234567"])
    expect(result.ok).toBe(true) // credits reserved; cron is the safety net
    expect(dispatches()).toHaveLength(1)
    expect(marks()).toHaveLength(0)
  })

  it("hubtel dispatch: marks rows with provider ids, no unconfirmed tagging", async () => {
    h.state.dispatchProvider = "hubtel"
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"])
    expect(result.ok).toBe(true)
    expect(marks()[0].args.p_provider).toBe("hubtel")
    expect(marks()[0].args.p_rows[0]).toEqual({ id: "m0", mid: "hm-m0", bid: "B1" })
    expect(h.state.msgUpdates).toHaveLength(0)
  })

  it("hubtel rows placed without ids (unknown outcome) are tagged last_error=hubtel_unconfirmed", async () => {
    h.state.dispatchProvider = "hubtel"
    h.state.unconfirmed = true
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567", "0551234567"])
    expect(result.ok).toBe(true)
    expect(h.state.msgUpdates).toHaveLength(1)
    expect(h.state.msgUpdates[0].patch).toEqual({ last_error: "hubtel_unconfirmed" })
    expect(h.state.msgUpdates[0].ids).toEqual(["m0", "m1"])
  })

  it("dispatch throwing never refunds and still returns ok:true", async () => {
    h.state.dispatchThrows = true
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"])
    expect(result.ok).toBe(true)
    expect(rpcs().some((c) => c.fn === "adjust_sms_units")).toBe(false)
    expect(rpcs().some((c) => c.fn === "recompute_sms_send_result")).toBe(true)
  })

  it("EMPTY_MESSAGE after prepare → ok:false, no debit", async () => {
    // A message that is purely undeliverable chars or empty after stripping
    // Easiest: pass an empty string variant that will fail the length check
    const result = await enqueueSend("u1", "acc1", "   ", ["0241234567"])
    // prepareSmsMessage will strip to empty → EMPTY_MESSAGE
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("EMPTY_MESSAGE")
    expect(rpcs().map((c) => c.fn)).not.toContain("debit_sms_for_send")
  })

  it("invalid phones are NOT billed — debit only the valid recipients (C3)", async () => {
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567", "not-a-phone", "0551234567"])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.total).toBe(2) // only the 2 valid numbers
      expect(result.invalidSkipped).toBe(1)
      expect(result.creditsReserved).toBe(result.segments * 2) // billed for 2, not 3
    }
    const debitCall = rpcs().find((c) => c.fn === "debit_sms_for_send")
    expect(debitCall!.args.p_credits).toBe((result as any).creditsReserved)
  })

  it("all recipients invalid → NO_VALID_RECIPIENTS, no debit", async () => {
    const result = await enqueueSend("u1", "acc1", "Hello world", ["abc", "12", "xyz"])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("NO_VALID_RECIPIENTS")
    expect(rpcs().map((c) => c.fn)).not.toContain("debit_sms_for_send")
  })

  it("valid active senderId → stored (uppercased) on the log + message rows, debit proceeds", async () => {
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"], undefined, "myshop")
    expect(result.ok).toBe(true)
    const logRow = (() => { const i = inserts("sms_send_logs")[0]; return Array.isArray(i.args) ? i.args[0] : i.args })()
    expect(logRow.sender_id).toBe("MYSHOP")
    const msgRow = (() => { const i = inserts("sms_messages")[0]; return Array.isArray(i.args) ? i.args[0] : i.args })()
    expect(msgRow.sender_id).toBe("MYSHOP")
    expect(rpcs().some((c) => c.fn === "debit_sms_for_send")).toBe(true)
  })

  it("senderId that isn't an active sender for the account → INVALID_SENDER_ID, no debit", async () => {
    h.state.senderRow = null
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"], undefined, "ghost")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("INVALID_SENDER_ID")
    expect(rpcs().map((c) => c.fn)).not.toContain("debit_sms_for_send")
    expect(inserts("sms_messages")).toHaveLength(0)
  })

  it("senderId active on mNotify only (pending locally) → INVALID_SENDER_ID, no debit (local_status is canonical)", async () => {
    h.state.senderRow = { local_status: "pending" }
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"], undefined, "myshop")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("INVALID_SENDER_ID")
    expect(rpcs().map((c) => c.fn)).not.toContain("debit_sms_for_send")
  })

  it("queued send log records mode + policy_shadow (record-only)", async () => {
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"])
    expect(result.ok).toBe(true)
    const logRow = (() => { const i = inserts("sms_send_logs")[0]; return Array.isArray(i.args) ? i.args[0] : i.args })()
    expect(logRow.mode).toBe("platform")
    expect(logRow.policy_shadow).toMatchObject({ decision: "allow", enforced: false })
  })

  it("blocked send log also records mode + policy_shadow", async () => {
    await enqueueSend("u1", "acc1", "Congratulations, you have won a prize!", ["0241234567"])
    const logRow = (() => { const i = inserts("sms_send_logs")[0]; return Array.isArray(i.args) ? i.args[0] : i.args })()
    expect(logRow.status).toBe("blocked")
    expect(logRow.mode).toBe("platform")
    expect(logRow.policy_shadow).toBeTruthy()
  })

  it("senderId pending on BOTH providers → still INVALID_SENDER_ID, no debit", async () => {
    h.state.senderRow = { local_status: "pending" }
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"], undefined, "myshop")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("INVALID_SENDER_ID")
    expect(rpcs().map((c) => c.fn)).not.toContain("debit_sms_for_send")
  })

  it("no senderId → sender_id null on the log, default-sender path (back-compat)", async () => {
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"])
    expect(result.ok).toBe(true)
    const logRow = (() => { const i = inserts("sms_send_logs")[0]; return Array.isArray(i.args) ? i.args[0] : i.args })()
    expect(logRow.sender_id).toBeNull()
  })

  it("queue insert fails AFTER debit → refunds the reservation + ENQUEUE_FAILED (C3)", async () => {
    h.state.insertLogError = "log insert boom"
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567", "0551234567"])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("ENQUEUE_FAILED")
    // debit happened, then a compensating refund (adjust_sms_units, positive delta, campaign_refund)
    const refund = rpcs().find((c) => c.fn === "adjust_sms_units")
    expect(refund).toBeTruthy()
    expect(refund!.args.p_reason).toBe("campaign_refund")
    expect(refund!.args.p_delta).toBeGreaterThan(0)
  })
})
