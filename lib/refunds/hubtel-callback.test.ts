import { handleHubtelRefundCallback } from "./hubtel-callback"
import type { RefundDeps, StoredRefund } from "./service"
import type { RefundableOrder } from "./types"

vi.mock("./hubtel-refund", () => ({ verifyCallbackToken: (_id: string, t: string) => t === "good" }))

const order: RefundableOrder = {
  table: "ussd_shop_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: "sA", shopName: "Alpha", packageLabel: "2", network: "MTN", recipientPhone: "0243334444",
  createdAt: "2026-10-05", paid: 10, gatewayFee: 0.2,
  payment: { gateway: "hubtel", reference: "o1", payerPhone: "0241112222", walletUserId: null },
  owners: [],
  evidence: { hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null },
}

const row = (o: Partial<StoredRefund> = {}): StoredRefund => ({
  id: "rf1", order_table: "ussd_shop_orders", order_id: "o1", gateway: "hubtel", amount: 0.5,
  destination_phone: "0241112222", gateway_ref: "HO-1", status: "processing", clawbacks: [],
  updated_at: "2026-10-05T12:00:00Z", ...o,
})

const okBody = { responseCode: "0000", message: "Successful", data: { amount: 0.5, charges: 0.01, orderId: "HO-1", externalTransactionId: "0000002673867446" } }

function setup(rows: (StoredRefund | null)[] = [row()]) {
  const calls: { name: string; args: any }[] = []
  const deps: RefundDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      return { data: name === "complete_order_refund" ? "completed" : null, error: null }
    },
    loadOrder: async () => order,
    getGateway: () => undefined,
    notify: vi.fn(async () => {}),
  }
  let i = 0
  const loadRefund = vi.fn(async () => rows[Math.min(i++, rows.length - 1)])
  const run = (over: { refundId?: string | null; token?: string | null; body?: unknown } = {}) =>
    handleHubtelRefundCallback(deps, {
      refundId: "refundId" in over ? over.refundId! : "rf1",
      token: "token" in over ? over.token! : "good",
      body: "body" in over ? over.body : okBody,
      loadRefund,
    })
  return { deps, calls, loadRefund, run }
}

describe("handleHubtelRefundCallback", () => {
  it.each([null, "bad"])("rejects token %s with 401 and reads nothing", async (token) => {
    const { run, loadRefund, calls } = setup()
    expect(await run({ token })).toEqual({ status: 401, body: { ok: false } })
    expect(loadRefund).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it("rejects a missing refund id with 401", async () => {
    const { run, loadRefund } = setup()
    expect((await run({ refundId: null })).status).toBe(401)
    expect(loadRefund).not.toHaveBeenCalled()
  })

  it("404s a missing refund", async () => {
    const { run, calls } = setup([null])
    expect((await run()).status).toBe(404)
    expect(calls).toEqual([])
  })

  it("404s a non-hubtel refund", async () => {
    const { run, calls } = setup([row({ gateway: "paystack" })])
    expect((await run()).status).toBe(404)
    expect(calls).toEqual([])
  })

  it("replay on a completed row is a 200 no-op", async () => {
    const { run, calls, deps } = setup([row({ status: "completed" })])
    expect(await run()).toEqual({ status: 200, body: { ok: true, note: "already settled" } })
    expect(calls).toEqual([])
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it("re-reads the row before settling: completed in between => no-op", async () => {
    const { run, calls, loadRefund } = setup([row(), row({ status: "completed" })])
    expect(await run()).toEqual({ status: 200, body: { ok: true, note: "already settled" } })
    expect(loadRefund).toHaveBeenCalledTimes(2)
    expect(calls).toEqual([])
  })

  it("settles a matching success callback with external id and charges", async () => {
    const { run, calls, deps } = setup()
    expect((await run()).status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe("complete_order_refund")
    expect(calls[0].args.p_gateway_ref).toBe("0000002673867446 (charges GHS 0.01)")
    expect(deps.notify).toHaveBeenCalled()
  })

  const parked = (calls: { name: string; args: any }[]) => {
    expect(calls.map((c) => c.name)).toEqual(["mark_refund_processing"])
    expect(calls[0].args).toMatchObject({ p_status: "processing", p_gateway_ref: null })
    return calls[0].args.p_note as string
  }

  it("parks on amount mismatch", async () => {
    const { run, calls } = setup()
    expect((await run({ body: { ...okBody, data: { ...okBody.data, amount: 0.6 } } })).status).toBe(200)
    expect(parked(calls)).toMatch(/Hubtel callback 0000: Successful — review/)
  })

  it("parks on orderId mismatch", async () => {
    const { run, calls } = setup()
    expect((await run({ body: { ...okBody, data: { ...okBody.data, orderId: "OTHER" } } })).status).toBe(200)
    parked(calls)
  })

  it("parks on a non-success response code", async () => {
    const { run, calls } = setup()
    expect((await run({ body: { responseCode: "4509", message: "Declined", data: null } })).status).toBe(200)
    expect(parked(calls)).toBe("Hubtel callback 4509: Declined — review")
  })

  it.each([null, "text", 42, [1]])("parks on non-object body %j", async (body) => {
    const { run, calls } = setup()
    expect((await run({ body })).status).toBe(200)
    parked(calls)
  })

  it("strips control characters and caps code and message at 120 chars", async () => {
    const { run, calls } = setup()
    await run({ body: { responseCode: "9\n9", message: "x\u0000y".repeat(100) } })
    const note = parked(calls)
    expect(note).not.toMatch(/[\u0000-\u001f]/)
    expect(note.length).toBeLessThan(120 + 120 + 40)
  })
})
