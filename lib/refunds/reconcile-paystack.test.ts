import { beforeEach, describe, expect, it, vi } from "vitest"

const fetchRefund = vi.fn()
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: (...a: unknown[]) => fetchRefund(...a) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { MAX_PER_RUN, reconcileProcessingPaystackRefunds } from "./reconcile-paystack"
import { getGateway } from "./gateways"
import { reconcileRefund, type RefundDeps, type StoredRefund } from "./service"
import type { RefundableOrder } from "./types"

const NOW = Date.parse("2026-10-05T12:00:00Z")
const order = { table: "ussd_shop_orders", id: "o1", payment: { gateway: "paystack", reference: "r", payerPhone: null, walletUserId: null }, owners: [], evidence: {} } as unknown as RefundableOrder
const row = (o: Partial<StoredRefund> = {}): StoredRefund => ({
  id: "rf1", order_table: "ussd_shop_orders", order_id: "o1", gateway: "paystack", amount: 9.8,
  destination_phone: null, gateway_ref: "99", status: "processing", clawbacks: [],
  updated_at: new Date(NOW - 10 * 60_000).toISOString(), ...o,
})

type RpcResult = { data: unknown; error: { message: string } | null }
function setup(rpcOverride?: (name: string) => RpcResult | undefined) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const deps = {
    rpc: async (name: string, args: Record<string, unknown>): Promise<RpcResult> => {
      calls.push({ name, args })
      return rpcOverride?.(name) ?? { data: name === "complete_order_refund" ? "completed" : name === "fail_order_refund" ? "failed" : null, error: null }
    },
    loadOrder: async () => order,
    getGateway,
    notify: vi.fn(async () => {}),
    now: () => NOW,
  } as unknown as RefundDeps
  return { deps, calls }
}
const errSpy = () => console.error as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("reconcileRefund on a Paystack processing row", () => {
  it("processed -> complete_order_refund + notify", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "processed" })
    const { deps, calls } = setup()
    expect((await reconcileRefund(deps, row())).status).toBe("completed")
    expect(calls.map((c) => c.name)).toEqual(["complete_order_refund"])
    expect(calls[0].args).toMatchObject({ p_refund_id: "rf1", p_gateway_ref: "99" })
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })
  it("failed -> fail_order_refund, no notify", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "failed" })
    const { deps, calls } = setup()
    expect((await reconcileRefund(deps, row())).status).toBe("failed")
    expect(calls.map((c) => c.name)).toEqual(["fail_order_refund"])
    expect(deps.notify).not.toHaveBeenCalled()
  })
  it.each(["pending", "processing", "needs-attention"])("%s -> stays processing keeping the ref, never compensates", async (status) => {
    fetchRefund.mockResolvedValue({ id: 99, status })
    const { deps, calls } = setup()
    expect((await reconcileRefund(deps, row())).status).toBe("processing")
    expect(calls.map((c) => c.name)).toEqual(["mark_refund_processing"])
    expect(calls[0].args).toMatchObject({ p_gateway_ref: "99", p_status: "processing" })
  })
  it("unknown status / lookup error -> never completes or compensates", async () => {
    for (const arrange of [
      () => fetchRefund.mockResolvedValue({ id: 99, status: "weird" }),
      () => fetchRefund.mockRejectedValue(Object.assign(new Error("nf"), { httpStatus: 404 })),
    ]) {
      arrange()
      const { deps, calls } = setup()
      expect((await reconcileRefund(deps, row())).status).toBe("processing")
      expect(calls.map((c) => c.name)).toEqual(["mark_refund_processing"])
    }
  })
})

describe("reconcileProcessingPaystackRefunds", () => {
  it("counts completed / failed / still processing", async () => {
    fetchRefund.mockImplementation(async (id: string) => ({ id, status: id === "1" ? "processed" : id === "2" ? "failed" : "pending" }))
    const { deps } = setup()
    const r = await reconcileProcessingPaystackRefunds(deps, [row({ id: "a", gateway_ref: "1" }), row({ id: "b", gateway_ref: "2" }), row({ id: "c", gateway_ref: "3" })], NOW)
    expect(r).toMatchObject({ checked: 3, completed: 1, failed: 1, stillProcessing: 1, errors: 0, stale24h: 0 })
  })
  it("skips non-numeric / missing refs and non-paystack / non-processing rows without calling Paystack", async () => {
    const { deps } = setup()
    const r = await reconcileProcessingPaystackRefunds(deps, [
      row({ gateway_ref: null }), row({ gateway_ref: "ref-1" }), row({ gateway: "wallet" }), row({ status: "completed" }),
    ], NOW)
    expect(r).toMatchObject({ checked: 0, skipped: 4 })
    expect(fetchRefund).not.toHaveBeenCalled()
  })
  it("IN_FLIGHT is tolerated and the loop continues", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "processed" })
    const { deps } = setup()
    const r = await reconcileProcessingPaystackRefunds(deps, [row({ id: "a", updated_at: new Date(NOW - 60_000).toISOString() }), row({ id: "b" })], NOW)
    expect(r).toMatchObject({ checked: 2, stillProcessing: 1, completed: 1, errors: 0 })
  })
  it("NOT_FOUND (order missing) is tolerated and the loop continues", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "processed" })
    const { deps } = setup()
    const load = deps.loadOrder
    let n = 0
    deps.loadOrder = async (...a) => (++n === 1 ? null : load(...a))
    const r = await reconcileProcessingPaystackRefunds(deps, [row({ id: "a" }), row({ id: "b" })], NOW)
    expect(r).toMatchObject({ checked: 2, stillProcessing: 1, completed: 1, errors: 0 })
  })
  it("SETTLE_FAILED is logged loudly with the refund id, counted as an error, and the loop continues", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "processed" })
    let n = 0
    const { deps } = setup((name) => (name === "complete_order_refund" && ++n === 1 ? { data: null, error: { message: "db down" } } : undefined))
    const r = await reconcileProcessingPaystackRefunds(deps, [row({ id: "bad" }), row({ id: "good" })], NOW)
    expect(r).toMatchObject({ checked: 2, errors: 1, completed: 1 })
    expect(errSpy().mock.calls.some((c) => String(c[0]).includes("SETTLE_FAILED") && String(c[0]).includes("bad"))).toBe(true)
  })
  it("a thrown unexpected error does not stop later rows", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "processed" })
    const { deps } = setup()
    const load = deps.loadOrder
    let n = 0
    deps.loadOrder = async (...a) => { if (++n === 1) throw new Error("boom"); return load(...a) }
    const r = await reconcileProcessingPaystackRefunds(deps, [row({ id: "a" }), row({ id: "b" })], NOW)
    expect(r).toMatchObject({ checked: 2, errors: 1, completed: 1 })
  })
  it("counts and logs processing rows older than 24h as needing attention", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "needs-attention" })
    const { deps } = setup()
    const r = await reconcileProcessingPaystackRefunds(deps, [row({ id: "old", updated_at: new Date(NOW - 25 * 3_600_000).toISOString() }), row({ id: "new" })], NOW)
    expect(r.stale24h).toBe(1)
    expect(errSpy().mock.calls.some((c) => c[0] === "[REFUND-CRON] needs attention: old")).toBe(true)
  })
  it("processes at most MAX_PER_RUN rows, sequentially", async () => {
    let active = 0
    let maxActive = 0
    fetchRefund.mockImplementation(async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return { id: 99, status: "pending" } })
    const { deps } = setup()
    const rows = Array.from({ length: MAX_PER_RUN + 10 }, (_, i) => row({ id: `r${i}` }))
    expect((await reconcileProcessingPaystackRefunds(deps, rows, NOW)).checked).toBe(MAX_PER_RUN)
    expect(maxActive).toBe(1)
  })
})
