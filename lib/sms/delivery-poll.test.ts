import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>, // keyed by select string
  fromCalls: 0,
  rpcCalls: [] as { name: string; args: any }[],
  rpcImpl: (_name: string, _args: any): { data: unknown; error: { message: string } | null } => ({ data: null, error: null }),
  cfg: { clientId: "id", clientSecret: "s" } as { clientId: string; clientSecret: string } | null,
  batchStatus: vi.fn(),
  messageStatus: vi.fn(),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      h.fromCalls++
      let sel = ""
      const chain: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: unknown) => void) => res({ data: h.tables[sel] ?? [], error: null })
          }
          if (prop === "select") return (s: string) => { sel = s; return chain }
          return () => chain
        },
      })
      return chain
    },
    rpc: async (name: string, args: any) => {
      h.rpcCalls.push({ name, args })
      return h.rpcImpl(name, args)
    },
  }),
}))
vi.mock("./providers/hubtel", () => ({
  hubtelConfigFromEnv: () => h.cfg,
  hubtelGetBatchStatus: (...a: unknown[]) => h.batchStatus(...a),
  hubtelGetMessageStatus: (...a: unknown[]) => h.messageStatus(...a),
}))

import { toDeliveryReports, summarizeApplied, DLR_GIVE_UP_MS, pollHubtelDeliveries } from "./delivery-poll"

describe("toDeliveryReports", () => {
  it("maps status entries to RPC rows", () => {
    expect(toDeliveryReports([
      { messageId: "m1", state: "delivered", rawStatus: "Delivered", rate: 0.03, updateTime: "2026-10-10T10:00:00" },
      { messageId: "m2", state: "pending", rawStatus: "Sent" },
    ])).toEqual([
      { mid: "m1", state: "delivered", rate: 0.03, at: "2026-10-10T10:00:00Z" },
      { mid: "m2", state: "pending", rate: null, at: null },
    ])
  })
  it("keeps an explicit zone untouched", () => {
    expect(toDeliveryReports([{ messageId: "m", state: "failed", rawStatus: "x", updateTime: "2026-10-10T10:00:00+01:00" }])[0].at)
      .toBe("2026-10-10T10:00:00+01:00")
  })
})

describe("summarizeApplied", () => {
  it("counts outcomes and collects send logs", () => {
    const s = summarizeApplied([
      { out_message_id: "a", out_send_log_id: 1, out_outcome: "delivered", out_refunded: false },
      { out_message_id: "b", out_send_log_id: 1, out_outcome: "failed", out_refunded: true },
      { out_message_id: "c", out_send_log_id: 2, out_outcome: "failed", out_refunded: false },
    ])
    expect(s).toEqual({ delivered: 1, failed: 2, refunded: 1, sendLogIds: [1, 2] })
  })
})

it("gives up after 72 hours", () => expect(DLR_GIVE_UP_MS).toBe(72 * 3_600_000))

describe("pollHubtelDeliveries", () => {
  const NOW = Date.parse("2026-10-10T12:00:00Z")
  const rpcs = (n: string) => h.rpcCalls.filter((c) => c.name === n)
  const picks = (batches: unknown, singles: unknown = [], closed: unknown = []) => {
    const base = h.rpcImpl
    h.rpcImpl = (name, args) => {
      if (name === "pick_sms_dlr_batches") return { data: batches, error: null }
      if (name === "pick_sms_dlr_singles") return { data: singles, error: null }
      if (name === "close_stale_sms_deliveries") return { data: closed, error: null }
      return base(name, args)
    }
  }
  beforeEach(() => {
    h.fromCalls = 0
    h.rpcCalls = []
    h.rpcImpl = () => ({ data: null, error: null })
    h.cfg = { clientId: "id", clientSecret: "s" }
    h.batchStatus.mockReset()
    h.messageStatus.mockReset()
  })

  it("returns a zero summary without querying when creds are missing", async () => {
    h.cfg = null
    const s = await pollHubtelDeliveries()
    expect(s).toEqual({ batches: 0, singles: 0, delivered: 0, failed: 0, refunded: 0, closed: 0, errors: 0 })
    expect(h.rpcCalls).toEqual([])
  })

  it("passes the readiness/give-up window and limits to the pick RPCs", async () => {
    await pollHubtelDeliveries({ now: NOW })
    const window = { p_ready_before: new Date(NOW - 60_000).toISOString(), p_give_up_before: new Date(NOW - DLR_GIVE_UP_MS).toISOString() }
    expect(rpcs("pick_sms_dlr_batches")[0].args).toEqual({ ...window, p_limit: 20 })
    expect(rpcs("pick_sms_dlr_singles")[0].args).toEqual({ ...window, p_limit: 50 })
    expect(rpcs("close_stale_sms_deliveries")[0].args).toEqual({ p_before: window.p_give_up_before, p_limit: 200 })
  })

  it("applies batch reports, uses a short status timeout, and recomputes touched send logs", async () => {
    picks([{ provider_batch_id: "b1" }])
    h.batchStatus.mockResolvedValue({ ok: true, messages: [{ messageId: "m1", state: "failed", rawStatus: "Rejected" }] })
    const base = h.rpcImpl
    h.rpcImpl = (name, a) => name === "apply_sms_delivery_reports"
      ? { data: [{ out_message_id: "u1", out_send_log_id: 7, out_outcome: "failed", out_refunded: true }], error: null }
      : base(name, a)
    const s = await pollHubtelDeliveries({ now: NOW })
    expect(h.batchStatus).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 8000 }), "b1")
    expect(s).toMatchObject({ batches: 1, failed: 1, refunded: 1, errors: 0 })
    expect(rpcs("apply_sms_delivery_reports")[0].args).toEqual({ p_rows: [{ mid: "m1", state: "failed", rate: null, at: null }] })
    expect(rpcs("recompute_sms_send_result")).toEqual([{ name: "recompute_sms_send_result", args: { p_send_log_id: 7, max_attempts: 3 } }])
  })

  it("counts a failed status call as an error, continues, and still marks it checked", async () => {
    picks([{ provider_batch_id: "b1" }, { provider_batch_id: "b2" }])
    h.batchStatus
      .mockResolvedValueOnce({ ok: false, error: "Hubtel HTTP 500", messages: [] })
      .mockResolvedValueOnce({ ok: true, messages: [{ messageId: "m2", state: "delivered", rawStatus: "Delivered" }] })
    const base = h.rpcImpl
    h.rpcImpl = (name, a) => name === "apply_sms_delivery_reports"
      ? { data: [{ out_message_id: "u2", out_send_log_id: 3, out_outcome: "delivered", out_refunded: false }], error: null }
      : base(name, a)
    const s = await pollHubtelDeliveries({ now: NOW })
    expect(s).toMatchObject({ batches: 2, errors: 1, delivered: 1 })
    expect(rpcs("mark_sms_dlr_checked")[0].args).toEqual({ p_batch_ids: ["b1", "b2"], p_message_ids: [] })
  })

  it("polls drain-sent singles by message id and marks them checked", async () => {
    picks([], [{ provider_message_id: "hm1" }])
    h.messageStatus.mockResolvedValue({ ok: true, messages: [{ messageId: "hm1", state: "pending", rawStatus: "Sent" }] })
    const s = await pollHubtelDeliveries({ now: NOW })
    expect(h.messageStatus).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 8000 }), "hm1")
    expect(s.singles).toBe(1)
    expect(rpcs("mark_sms_dlr_checked")[0].args).toEqual({ p_batch_ids: [], p_message_ids: ["hm1"] })
  })

  it("closes 72h stragglers via close_stale_sms_deliveries and rolls their send logs up", async () => {
    picks([], [], [
      { out_message_id: "x1", out_send_log_id: 5, out_refunded: true },
      { out_message_id: "x2", out_send_log_id: 5, out_refunded: false },
    ])
    const s = await pollHubtelDeliveries({ now: NOW })
    expect(s).toMatchObject({ closed: 2, refunded: 1, errors: 0 })
    expect(rpcs("refund_sms_message")).toHaveLength(0)
    expect(rpcs("recompute_sms_send_result")).toEqual([{ name: "recompute_sms_send_result", args: { p_send_log_id: 5, max_attempts: 3 } }])
  })

  it("runs the 72h close before the pick RPCs", async () => {
    await pollHubtelDeliveries({ now: NOW })
    const names = h.rpcCalls.map((c) => c.name)
    expect(names.indexOf("close_stale_sms_deliveries")).toBe(0)
    expect(names.indexOf("close_stale_sms_deliveries")).toBeLessThan(names.indexOf("pick_sms_dlr_batches"))
  })

  it("still closes 72h stragglers but makes no Hubtel calls when the deadline has passed", async () => {
    picks([{ provider_batch_id: "b1" }], [{ provider_message_id: "hm1" }], [{ out_message_id: "x1", out_send_log_id: 5, out_refunded: true }])
    const s = await pollHubtelDeliveries({ now: NOW, deadlineMs: Date.now() - 1 })
    expect(h.batchStatus).not.toHaveBeenCalled()
    expect(h.messageStatus).not.toHaveBeenCalled()
    expect(rpcs("pick_sms_dlr_batches")).toHaveLength(0)
    expect(s).toEqual({ batches: 0, singles: 0, delivered: 0, failed: 0, refunded: 1, closed: 1, errors: 0 })
    expect(rpcs("recompute_sms_send_result")).toHaveLength(1)
  })

  it("stops starting new Hubtel calls mid-phase once the deadline hits", async () => {
    picks([{ provider_batch_id: "b1" }, { provider_batch_id: "b2" }])
    const deadline = Date.now() + 5_000
    h.batchStatus.mockImplementation(async () => {
      vi.setSystemTime(deadline + 1)
      return { ok: true, messages: [] }
    })
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(deadline - 5_000)
    try {
      await pollHubtelDeliveries({ now: NOW, deadlineMs: deadline })
    } finally { vi.useRealTimers() }
    expect(h.batchStatus).toHaveBeenCalledTimes(1)
    expect(rpcs("mark_sms_dlr_checked")[0].args).toEqual({ p_batch_ids: ["b1"], p_message_ids: [] })
  })

  it("counts a discovery error and carries on", async () => {
    const base = h.rpcImpl
    h.rpcImpl = (name, a) => name === "pick_sms_dlr_batches" ? { data: null, error: { message: "boom" } } : base(name, a)
    const s = await pollHubtelDeliveries({ now: NOW })
    expect(s.errors).toBe(1)
    expect(h.batchStatus).not.toHaveBeenCalled()
    expect(rpcs("close_stale_sms_deliveries")).toHaveLength(1)
  })

  it("counts a close error", async () => {
    const base = h.rpcImpl
    h.rpcImpl = (name, a) => name === "close_stale_sms_deliveries" ? { data: null, error: { message: "boom" } } : base(name, a)
    const s = await pollHubtelDeliveries({ now: NOW })
    expect(s).toMatchObject({ errors: 1, closed: 0 })
  })
})
