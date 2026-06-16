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
    senderActive: true,                 // sms_sender_ids validation finds an active row for the account
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
      // Return a chainable builder
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
      const msgInsertResult = {
        then: (resolve: any) => {
          const result = table === "sms_messages" && state.insertMsgError
            ? { data: null, error: { message: state.insertMsgError } }
            : { data: null, error: null }
          resolve(result)
          return Promise.resolve(result)
        },
      }

      return {
        insert: (rows: any) => {
          state.calls.push({ fn: "insert", table, args: rows })
          if (table === "sms_send_logs") return insertChain
          // sms_messages — just return { error: null }
          if (state.insertMsgError) {
            return Promise.resolve({ data: null, error: { message: state.insertMsgError } })
          }
          return Promise.resolve({ data: null, error: null })
        },
        // sms_sender_ids validation: .select("sender_id").eq().eq().eq().maybeSingle()
        select: (_cols?: string) => {
          const chain: any = {
            eq: () => chain,
            maybeSingle: () =>
              Promise.resolve({ data: state.senderActive ? { sender_id: "MYSHOP" } : null, error: null }),
          }
          return chain
        },
        update: () => ({
          eq: () => ({
            lt: () => Promise.resolve({ data: null, error: null }),
          }),
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

// Mock the drain so the fire-and-forget doesn't cause noise in tests
vi.mock("./send-drain", () => ({
  drainSmsMessages: () => Promise.resolve({ claimed: 0, sent: 0, failed: 0, refunded: 0 }),
}))

import { enqueueSend } from "./send-service"

beforeEach(() => {
  h.state.calls.length = 0
  h.state.debitError = null
  h.state.insertLogId = "log-1"
  h.state.insertLogError = null
  h.state.insertMsgError = null
  h.state.senderActive = true
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
    h.state.senderActive = false
    const result = await enqueueSend("u1", "acc1", "Hello world", ["0241234567"], undefined, "ghost")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("INVALID_SENDER_ID")
    expect(rpcs().map((c) => c.fn)).not.toContain("debit_sms_for_send")
    expect(inserts("sms_messages")).toHaveLength(0)
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
