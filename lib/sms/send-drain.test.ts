import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.hoisted — must exist before the module under test imports supabase at module level.
const h = vi.hoisted(() => {
  type Row = {
    id: string
    send_log_id: string
    sms_account_id: string
    phone: string
    rendered_message: string
    segments: number
    attempts: number
    sender_id?: string | null
  }

  const state = {
    claimedRows: [] as Row[],
    updates: [] as { table: string; data: any; id?: string }[],
    rpcs: [] as { fn: string; args?: any }[],
    refundError: false,           // force refund_sms_message to error
    updateError: false,           // force the per-row update to return an error
    refundResult: true,          // refund_sms_message data (false = already refunded)
    refundFailuresInsertError: false,  // force sms_refund_failures insert to fail
    recomputeError: false,
    sendSuccess: true,            // sendSMS returns success or failure
    sendRef: "moolre-abc",
    sendProvider: "moolre",
    sendError: "provider failed",
  }

  const fake = {
    from: (table: string) => ({
      update: (data: any) => ({
        eq: (col: string, val: any) => {
          const filters: Record<string, any> = { [col]: val }
          const chain: any = {
            eq: (c2: string, v2: any) => { filters[c2] = v2; return chain },
            lt: (col2: string, val2: any) => Promise.resolve({ data: null, error: null }),
            then: (resolve: any) => {
              state.updates.push({ table, data, id: val, filters } as any)
              const r = { data: null, error: state.updateError ? { message: "update boom" } : null }
              resolve(r)
              return Promise.resolve(r)
            },
          }
          return chain
        },
        then: (resolve: any) => {
          state.updates.push({ table, data })
          const r = { data: null, error: null }
          resolve(r)
          return Promise.resolve(r)
        },
      }),
      insert: (rows: any) => {
        const row = Array.isArray(rows) ? rows[0] : rows
        if (table === "sms_refund_failures") {
          if (state.refundFailuresInsertError) {
            return { then: (resolve: any) => { resolve({ data: null, error: { message: "insert fail" } }); return Promise.resolve({ data: null, error: { message: "insert fail" } }) } }
          }
          state.rpcs.push({ fn: "sms_refund_failures.insert", args: row })
          return { then: (resolve: any) => { resolve({ data: null, error: null }); return Promise.resolve({ data: null, error: null }) } }
        }
        return { then: (resolve: any) => { resolve({ data: null, error: null }); return Promise.resolve({ data: null, error: null }) } }
      },
    }),
    rpc: (fn: string, args?: any) => {
      state.rpcs.push({ fn, args })
      if (fn === "claim_sms_messages") {
        return Promise.resolve({ data: state.claimedRows, error: null })
      }
      if (fn === "refund_sms_message") {
        if (state.refundError) {
          return Promise.resolve({ data: null, error: { message: "refund failed" } })
        }
        return Promise.resolve({ data: state.refundResult, error: null })
      }
      if (fn === "recompute_sms_send_result") {
        if (state.recomputeError) {
          return { then: (resolve: any) => { resolve({ data: null, error: { message: "recompute error" } }); return Promise.resolve({ data: null, error: { message: "recompute error" } }) } }
        }
        return { then: (resolve: any) => { resolve({ data: null, error: null }); return Promise.resolve({ data: null, error: null }) } }
      }
      return Promise.resolve({ data: null, error: null })
    },
  }

  const sendSmsMock = vi.fn()

  return { state, fake, sendSmsMock }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: (...args: any[]) => h.sendSmsMock(...args),
}))

import { drainSmsMessages, MAX_ATTEMPTS } from "./send-drain"

beforeEach(() => {
  h.state.claimedRows = []
  h.state.updates.length = 0
  h.state.rpcs.length = 0
  h.state.refundError = false
  h.state.refundResult = true
  h.state.updateError = false
  h.state.refundFailuresInsertError = false
  h.state.recomputeError = false
  h.state.sendSuccess = true
  h.sendSmsMock.mockReset()
})

const rpcNames = () => h.state.rpcs.map((r) => r.fn)

describe("drainSmsMessages", () => {
  it("no claimed rows → returns zeros", async () => {
    h.state.claimedRows = []
    h.sendSmsMock.mockResolvedValue({ success: true, ref: "r1", provider: "moolre" })
    const result = await drainSmsMessages()
    expect(result).toEqual({ claimed: 0, sent: 0, failed: 0, refunded: 0 })
    expect(h.sendSmsMock).not.toHaveBeenCalled()
  })

  it("claimed row that sends OK → status set to sent, no refund", async () => {
    h.state.claimedRows = [
      { id: "msg-1", send_log_id: "log-1", sms_account_id: "acc-1", phone: "+233241234567", rendered_message: "Hello", segments: 1, attempts: 0 },
    ]
    h.sendSmsMock.mockResolvedValue({ success: true, ref: "r1", messageId: "m1", provider: "moolre" })

    const result = await drainSmsMessages()
    expect(result.claimed).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.refunded).toBe(0)

    // refund NOT called (no refund on success)
    expect(rpcNames()).not.toContain("refund_sms_message")

    // recompute called for log-1
    const recompute = h.state.rpcs.find((r) => r.fn === "recompute_sms_send_result")
    expect(recompute).toBeTruthy()
    expect(recompute!.args.p_send_log_id).toBe("log-1")
  })

  it("passes the row's sender_id through to sendSMS", async () => {
    h.state.claimedRows = [
      { id: "msg-9", send_log_id: "log-9", sms_account_id: "acc-9", phone: "+233241234567", rendered_message: "Hi", segments: 1, attempts: 0, sender_id: "MYSHOP" },
    ]
    h.sendSmsMock.mockResolvedValue({ success: true, ref: "r9", provider: "moolre" })
    await drainSmsMessages()
    expect(h.sendSmsMock).toHaveBeenCalledWith(expect.objectContaining({ phone: "+233241234567", senderId: "MYSHOP" }))
  })

  it("null sender_id → sendSMS called with senderId undefined (platform default)", async () => {
    h.state.claimedRows = [
      { id: "msg-10", send_log_id: "log-10", sms_account_id: "acc-10", phone: "+233241234567", rendered_message: "Hi", segments: 1, attempts: 0, sender_id: null },
    ]
    h.sendSmsMock.mockResolvedValue({ success: true, ref: "r10", provider: "moolre" })
    await drainSmsMessages()
    expect(h.sendSmsMock).toHaveBeenCalledWith(expect.objectContaining({ senderId: undefined }))
  })

  it("Hubtel send success stores provider_message_id; other providers store null", async () => {
    h.state.claimedRows = [
      { id: "msg-h", send_log_id: "log-h", sms_account_id: "acc-1", phone: "+233241234567", rendered_message: "Hi", segments: 1, attempts: 0 },
      { id: "msg-m", send_log_id: "log-m", sms_account_id: "acc-1", phone: "+233241234568", rendered_message: "Hi", segments: 1, attempts: 0 },
    ]
    h.sendSmsMock
      .mockResolvedValueOnce({ success: true, messageId: "hub-1", provider: "hubtel" })
      .mockResolvedValueOnce({ success: true, messageId: "moo-1", provider: "moolre" })
    await drainSmsMessages()
    const hub = h.state.updates.find((u) => u.id === "msg-h")!
    const moo = h.state.updates.find((u) => u.id === "msg-m")!
    expect(hub.data.provider_message_id).toBe("hub-1")
    expect(moo.data.provider_message_id).toBeNull()
  })

  it("success update is guarded by status='claimed' and logs update errors", async () => {
    h.state.claimedRows = [
      { id: "msg-g", send_log_id: "log-g", sms_account_id: "acc-1", phone: "+233241234567", rendered_message: "Hi", segments: 1, attempts: 0 },
    ]
    h.sendSmsMock.mockResolvedValue({ success: true, messageId: "m", provider: "moolre" })
    h.state.updateError = true
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await drainSmsMessages()
    const upd = h.state.updates.find((u) => u.data.status === "sent") as any
    expect(upd.filters).toEqual({ id: "msg-g", status: "claimed" })
    expect(spy.mock.calls.some((c) => String(c[0]).includes("mark-sent update failed"))).toBe(true)
    spy.mockRestore()
  })

  it("already-refunded message (RPC returns false) is not counted as refunded", async () => {
    h.state.claimedRows = [
      { id: "msg-d", send_log_id: "log-d", sms_account_id: "acc-1", phone: "+233241234567", rendered_message: "Hi", segments: 1, attempts: MAX_ATTEMPTS },
    ]
    h.sendSmsMock.mockResolvedValue({ success: false, error: "x" })
    h.state.refundResult = false
    const result = await drainSmsMessages()
    expect(result.failed).toBe(1)
    expect(result.refunded).toBe(0)
    expect(h.state.rpcs.find((r) => r.fn === "sms_refund_failures.insert")).toBeUndefined()
  })

  it("row that fails at attempts>=MAX_ATTEMPTS → marked failed + refund_sms_message called", async () => {
    h.state.claimedRows = [
      { id: "msg-2", send_log_id: "log-2", sms_account_id: "acc-2", phone: "+233551234567", rendered_message: "Hi", segments: 2, attempts: MAX_ATTEMPTS },
    ]
    h.sendSmsMock.mockResolvedValue({ success: false, error: "provider timeout" })

    const result = await drainSmsMessages()
    expect(result.failed).toBe(1)
    expect(result.refunded).toBe(1)

    const refundCall = h.state.rpcs.find((r) => r.fn === "refund_sms_message")
    expect(refundCall).toBeTruthy()
    expect(refundCall!.args).toEqual({ p_message_id: "msg-2" })
  })

  it("row fails but attempts < MAX_ATTEMPTS → marked failed, NO refund", async () => {
    h.state.claimedRows = [
      { id: "msg-3", send_log_id: "log-3", sms_account_id: "acc-3", phone: "+233201234567", rendered_message: "Hi", segments: 1, attempts: 1 },
    ]
    h.sendSmsMock.mockResolvedValue({ success: false, error: "timeout" })

    const result = await drainSmsMessages()
    expect(result.failed).toBe(1)
    expect(result.refunded).toBe(0)
    expect(rpcNames()).not.toContain("refund_sms_message")
  })

  it("refund RPC errors → sms_refund_failures inserted, refunded count stays 0", async () => {
    h.state.claimedRows = [
      { id: "msg-4", send_log_id: "log-4", sms_account_id: "acc-4", phone: "+233241234567", rendered_message: "Hi", segments: 1, attempts: MAX_ATTEMPTS },
    ]
    h.sendSmsMock.mockResolvedValue({ success: false, error: "network error" })
    h.state.refundError = true

    const result = await drainSmsMessages()
    expect(result.failed).toBe(1)
    expect(result.refunded).toBe(0)

    // sms_refund_failures should have been inserted
    const failureInsert = h.state.rpcs.find((r) => r.fn === "sms_refund_failures.insert")
    expect(failureInsert).toBeTruthy()
    expect(failureInsert!.args.sms_account_id).toBe("acc-4")
    expect(failureInsert!.args.credits).toBe(1)
  })

  it("recompute called for each distinct send_log_id touched", async () => {
    h.state.claimedRows = [
      { id: "msg-5", send_log_id: "log-A", sms_account_id: "acc-1", phone: "+233241111111", rendered_message: "Hi", segments: 1, attempts: 0 },
      { id: "msg-6", send_log_id: "log-B", sms_account_id: "acc-1", phone: "+233242222222", rendered_message: "Hi", segments: 1, attempts: 0 },
      { id: "msg-7", send_log_id: "log-A", sms_account_id: "acc-1", phone: "+233243333333", rendered_message: "Hi", segments: 1, attempts: 0 },
    ]
    h.sendSmsMock.mockResolvedValue({ success: true, ref: "rx", provider: "moolre" })

    await drainSmsMessages()

    const recomputes = h.state.rpcs.filter((r) => r.fn === "recompute_sms_send_result")
    const recomputeLogIds = recomputes.map((r) => r.args.p_send_log_id)
    // Should have called once for log-A and once for log-B (2 distinct)
    expect(new Set(recomputeLogIds).size).toBe(2)
    expect(recomputeLogIds).toContain("log-A")
    expect(recomputeLogIds).toContain("log-B")
  })

  it("calls the RPCs with the EXACT arg names the SQL functions declare (C1 contract)", async () => {
    h.state.claimedRows = [
      { id: "msg-x", send_log_id: "log-x", sms_account_id: "acc-1", phone: "+233241234567", rendered_message: "Hi", segments: 1, attempts: 0 },
    ]
    h.sendSmsMock.mockResolvedValue({ success: true, ref: "r", provider: "moolre" })
    await drainSmsMessages({ limit: 7 })

    // claim_sms_messages(lim, max_attempts) — NOT p_limit/p_max_attempts
    const claim = h.state.rpcs.find((r) => r.fn === "claim_sms_messages")
    expect(claim!.args).toEqual({ lim: 7, max_attempts: MAX_ATTEMPTS })

    // recompute_sms_send_result(p_send_log_id, max_attempts) — NOT p_max_attempts
    const recompute = h.state.rpcs.find((r) => r.fn === "recompute_sms_send_result")
    expect(Object.keys(recompute!.args).sort()).toEqual(["max_attempts", "p_send_log_id"])
  })

  it("single row erroring does not abort the batch", async () => {
    h.state.claimedRows = [
      { id: "msg-8", send_log_id: "log-8", sms_account_id: "acc-1", phone: "+233241234567", rendered_message: "Hello", segments: 1, attempts: 0 },
      { id: "msg-9", send_log_id: "log-9", sms_account_id: "acc-1", phone: "+233551234567", rendered_message: "Hello", segments: 1, attempts: 0 },
    ]
    // First call throws, second succeeds
    h.sendSmsMock
      .mockRejectedValueOnce(new Error("unexpected crash"))
      .mockResolvedValueOnce({ success: true, ref: "r2", provider: "moolre" })

    const result = await drainSmsMessages()
    expect(result.claimed).toBe(2)
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
  })
})
