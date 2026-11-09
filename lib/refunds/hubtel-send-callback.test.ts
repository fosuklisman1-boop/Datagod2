import { beforeEach, describe, expect, it, vi } from "vitest"

const checkSendStatus = vi.fn()
vi.mock("./hubtel-send-client", async (orig) => ({
  ...(await orig<typeof import("./hubtel-send-client")>()),
  checkSendStatus: (...a: unknown[]) => checkSendStatus(...a),
}))
vi.mock("@/lib/moolre-transfer", () => ({ initiateTransfer: vi.fn(), getTransferStatus: vi.fn() }))
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: vi.fn() }))
vi.mock("@/lib/paystack-transfer", () => ({
  createRecipient: vi.fn(), initiateTransfer: vi.fn(), finalizeTransfer: vi.fn(), getTransferStatus: vi.fn(), mapNetworkToPaystackBankCode: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: vi.fn() }) }))

import { handleHubtelSendCallback, refundIdFromSendRef } from "./hubtel-send-callback"
import { getGateway } from "./gateways"
import { signRef } from "@/lib/hubtel-cs/callback"
import type { RefundDeps, StoredRefund } from "./service"
import type { RefundableOrder } from "./types"

const RF = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
const REF = "3f2504e04f8941d39a0c0305e82c3301"
const SECRET = "s".repeat(40)
const sigFor = (ref: string, secret = SECRET) => signRef(`send:${ref}`, secret)
const NOW = Date.parse("2026-11-05T12:00:00Z")

const order = { table: "shop_orders", id: "o1", payment: { gateway: "hubtel", reference: null, payerPhone: null, walletUserId: null }, owners: [], evidence: {} } as unknown as RefundableOrder
const stored = (o: Partial<StoredRefund> = {}): StoredRefund => ({
  id: RF, order_table: "shop_orders", order_id: "o1", gateway: "hubtel_send", amount: 10, destination_phone: "0245550101",
  gateway_ref: "tx1", status: "processing", clawbacks: [],
  // updated a few seconds ago: the 5-minute in-flight guard must NOT stop a callback-triggered check
  updated_at: new Date(NOW - 5_000).toISOString(), created_at: new Date(NOW - 60_000).toISOString(), ...o,
})

function setup(row: StoredRefund | null) {
  const calls: { name: string; args: any }[] = []
  let current = row
  const deps = {
    rpc: async (name: string, args: any) => {
      calls.push({ name, args })
      if (name === "complete_order_refund") { if (current) current = { ...current, status: "completed" }; return { data: "completed", error: null } }
      if (name === "fail_order_refund") { if (current) current = { ...current, status: "failed" }; return { data: "failed", error: null } }
      return { data: null, error: null }
    },
    loadOrder: async () => order,
    getGateway,
    notify: vi.fn(async () => {}),
    now: () => NOW,
  } as unknown as RefundDeps
  const loadRefund = vi.fn(async (id: string) => (current && id === current.id ? current : null))
  const run = (over: Partial<{ ref: string | null; sig: string | null; secret: string | undefined }> = {}) =>
    handleHubtelSendCallback(deps, { ref: REF, sig: sigFor(REF), secret: SECRET, loadRefund, ...over })
  return { deps, calls, loadRefund, run }
}
const names = (c: { name: string }[]) => c.map((x) => x.name)

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}) })

describe("refundIdFromSendRef", () => {
  it("re-inserts the dashes", () => { expect(refundIdFromSendRef(REF)).toBe(RF) })
  it("rejects anything that is not 32 lowercase hex", () => {
    for (const v of ["", "abc", REF.toUpperCase(), `${REF}0`, null, undefined]) expect(refundIdFromSendRef(v as any)).toBeNull()
  })
})

describe("handleHubtelSendCallback", () => {
  it("a forged signature is refused and nothing is loaded or checked", async () => {
    const { run, loadRefund, calls } = setup(stored())
    for (const sig of ["0".repeat(64), "", null, signRef(REF, SECRET), signRef(`return:${REF}`, SECRET), sigFor(REF, "x".repeat(40))]) {
      expect((await run({ sig })).status).toBe(401)
    }
    expect(loadRefund).not.toHaveBeenCalled()
    expect(checkSendStatus).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it("a bad ref is refused", async () => {
    const { run, loadRefund } = setup(stored())
    expect((await run({ ref: null })).status).toBe(401)
    expect((await run({ ref: "nope", sig: sigFor("nope") })).status).toBe(401)
    expect(loadRefund).not.toHaveBeenCalled()
  })
  it("answers 503 when the callback secret is not configured, checking nothing", async () => {
    const { run } = setup(stored())
    expect((await run({ secret: undefined })).status).toBe(503)
    expect((await run({ secret: "short" })).status).toBe(503)
    expect(checkSendStatus).not.toHaveBeenCalled()
  })

  it("a callback never decides: the status check says pending, so nothing completes or fails", async () => {
    checkSendStatus.mockResolvedValue({ kind: "pending", ref: REF })
    const { run, calls } = setup(stored())
    const res = await run() // the route never even hands the body over
    expect(res.status).toBe(200)
    expect(checkSendStatus).toHaveBeenCalledTimes(1)
    expect(names(calls)).toEqual(["mark_refund_processing"])
    expect(names(calls)).not.toContain("complete_order_refund")
    expect(names(calls)).not.toContain("fail_order_refund")
  })
  it("the status check, not the callback, completes the refund; the amount is the refund's", async () => {
    checkSendStatus.mockResolvedValue({ kind: "completed", ref: "tx9" })
    const { run, calls, deps } = setup(stored())
    expect((await run()).status).toBe(200)
    expect(checkSendStatus).toHaveBeenCalledWith({ refundId: RF, amount: 10 })
    expect(names(calls)).toEqual(["complete_order_refund"])
    expect(calls[0].args).toMatchObject({ p_refund_id: RF, p_gateway_ref: "tx9" })
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })
  it("a status check that says failed fails the refund (clawback restored by the RPC)", async () => {
    checkSendStatus.mockResolvedValue({ kind: "failed", error: "Hubtel reports the payout failed" })
    const { run, calls } = setup(stored())
    await run()
    expect(names(calls)).toEqual(["fail_order_refund"])
  })
  it("a status check that could not run (unknown) keeps the refund processing", async () => {
    checkSendStatus.mockResolvedValue({ kind: "unknown", error: "relay down" })
    const { run, calls } = setup(stored())
    await run()
    expect(names(calls)).toEqual(["mark_refund_processing"])
  })
  it("a duplicate callback after settling is a no-op: refund and clawback run once", async () => {
    checkSendStatus.mockResolvedValue({ kind: "completed", ref: "tx9" })
    const { run, calls, deps } = setup(stored())
    await run()
    await run()
    await run()
    expect(names(calls).filter((n) => n === "complete_order_refund")).toHaveLength(1)
    expect(checkSendStatus).toHaveBeenCalledTimes(1)
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })
  it.each(["completed", "failed", "reserved", "awaiting_otp"])("a %s refund is not checked", async (status) => {
    const { run, calls } = setup(stored({ status }))
    const res = await run()
    expect(res.status).toBe(200)
    expect(checkSendStatus).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it("an unknown refund, or one on another gateway, is acknowledged and ignored", async () => {
    const a = setup(null)
    expect((await a.run()).status).toBe(200)
    const b = setup(stored({ gateway: "moolre" }))
    expect((await b.run()).status).toBe(200)
    expect(checkSendStatus).not.toHaveBeenCalled()
    expect(a.calls).toEqual([])
    expect(b.calls).toEqual([])
  })
  it("a throwing status check or loader is acknowledged (the cron is the backstop) and settles nothing", async () => {
    checkSendStatus.mockRejectedValue(new Error("boom"))
    const { run, calls } = setup(stored())
    expect((await run()).status).toBe(200)
    expect(calls.filter((c) => c.name === "complete_order_refund" || c.name === "fail_order_refund")).toEqual([])
    const bad = setup(stored())
    const res = await handleHubtelSendCallback(bad.deps, { ref: REF, sig: sigFor(REF), secret: SECRET, loadRefund: async () => { throw new Error("db") } })
    expect(res.status).toBe(200)
  })
  it("logs carry the refund id only, never a phone number", async () => {
    checkSendStatus.mockRejectedValue(new Error("boom for 233245550101"))
    const { run } = setup(stored())
    await run()
    const logged = JSON.stringify([...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls])
    expect(logged).not.toMatch(/245550101/)
  })
})
