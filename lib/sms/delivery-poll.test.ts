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
  beforeEach(() => {
    h.tables = {}
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
    expect(h.fromCalls).toBe(0)
    expect(h.rpcCalls).toEqual([])
  })

  it("applies batch reports and recomputes touched send logs", async () => {
    h.tables["provider_batch_id"] = [{ provider_batch_id: "b1" }, { provider_batch_id: "b1" }]
    h.batchStatus.mockResolvedValue({ ok: true, messages: [{ messageId: "m1", state: "failed", rawStatus: "Rejected" }] })
    h.rpcImpl = (name) => name === "apply_sms_delivery_reports"
      ? { data: [{ out_message_id: "u1", out_send_log_id: 7, out_outcome: "failed", out_refunded: true }], error: null }
      : { data: null, error: null }
    const s = await pollHubtelDeliveries()
    expect(h.batchStatus).toHaveBeenCalledTimes(1)
    expect(s).toMatchObject({ batches: 1, failed: 1, refunded: 1, errors: 0 })
    expect(h.rpcCalls[0]).toEqual({ name: "apply_sms_delivery_reports", args: { p_rows: [{ mid: "m1", state: "failed", rate: null, at: null }] } })
    expect(h.rpcCalls.at(-1)).toEqual({ name: "recompute_sms_send_result", args: { p_send_log_id: 7, max_attempts: 3 } })
  })

  it("counts a failed status call as an error and continues", async () => {
    h.tables["provider_batch_id"] = [{ provider_batch_id: "b1" }, { provider_batch_id: "b2" }]
    h.batchStatus
      .mockResolvedValueOnce({ ok: false, error: "Hubtel HTTP 500", messages: [] })
      .mockResolvedValueOnce({ ok: true, messages: [{ messageId: "m2", state: "delivered", rawStatus: "Delivered" }] })
    h.rpcImpl = (name) => name === "apply_sms_delivery_reports"
      ? { data: [{ out_message_id: "u2", out_send_log_id: 3, out_outcome: "delivered", out_refunded: false }], error: null }
      : { data: null, error: null }
    const s = await pollHubtelDeliveries()
    expect(s).toMatchObject({ batches: 2, errors: 1, delivered: 1 })
  })

  it("polls drain-sent singles by message id", async () => {
    h.tables["provider_message_id"] = [{ provider_message_id: "hm1" }]
    h.messageStatus.mockResolvedValue({ ok: true, messages: [{ messageId: "hm1", state: "pending", rawStatus: "Sent" }] })
    const s = await pollHubtelDeliveries()
    expect(h.messageStatus).toHaveBeenCalledWith(h.cfg, "hm1")
    expect(s.singles).toBe(1)
  })

  it("closes 72h stragglers (including unconfirmed rows) via refund_sms_message", async () => {
    h.tables["id, send_log_id"] = [{ id: "x1", send_log_id: 5 }, { id: "x2", send_log_id: 5 }]
    h.rpcImpl = (name, args) => name === "refund_sms_message"
      ? { data: args.p_message_id === "x1", error: null }
      : { data: null, error: null }
    const s = await pollHubtelDeliveries()
    expect(s).toMatchObject({ closed: 2, refunded: 1, errors: 0 })
    expect(h.rpcCalls.filter((c) => c.name === "refund_sms_message")).toHaveLength(2)
    expect(h.rpcCalls.filter((c) => c.name === "recompute_sms_send_result")).toEqual([
      { name: "recompute_sms_send_result", args: { p_send_log_id: 5, max_attempts: 3 } },
    ])
  })
})
