// app/api/webhooks/hubtel-send/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { signRef } from "@/lib/hubtel-cs/callback"

const h = vi.hoisted(() => ({ rpc: vi.fn(), row: null as any, check: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.row, error: null }) }) }) }),
  }),
}))
vi.mock("@/lib/refunds/hubtel-send-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/refunds/hubtel-send-client")>()),
  checkSendStatus: (...a: unknown[]) => h.check(...a),
}))
vi.mock("@/lib/moolre-transfer", () => ({ initiateTransfer: vi.fn(), getTransferStatus: vi.fn() }))
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: vi.fn() }))
vi.mock("@/lib/paystack-transfer", () => ({
  createRecipient: vi.fn(), initiateTransfer: vi.fn(), finalizeTransfer: vi.fn(), getTransferStatus: vi.fn(), mapNetworkToPaystackBankCode: vi.fn(),
}))
vi.mock("@/lib/refunds/orders", () => ({ loadRefundableOrders: async () => [{ table: "shop_orders", id: "o1", payment: {}, owners: [], evidence: {} }] }))

import * as route from "./route"

const SECRET = "s".repeat(40)
const RF = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
const REF = "3f2504e04f8941d39a0c0305e82c3301"
const sig = (ref = REF, secret = SECRET) => signRef(`send:${ref}`, secret)

const req = (q: Record<string, string>, body: unknown = { ResponseCode: "0000", Data: { ClientReference: REF, RecipientName: "233245550101" } }) => {
  const u = new URL("https://www.datagod.store/api/webhooks/hubtel-send")
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  return new NextRequest(u, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
}

let logs: string[]
beforeEach(() => {
  vi.clearAllMocks()
  process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET = SECRET
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k"
  h.row = { id: RF, order_table: "shop_orders", order_id: "o1", gateway: "hubtel_send", amount: 10, destination_phone: "0245550101", gateway_ref: "tx1", status: "processing", clawbacks: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString() }
  h.rpc.mockImplementation(async (name: string) => ({ data: name === "complete_order_refund" ? "completed" : name === "fail_order_refund" ? "failed" : null, error: null }))
  logs = []
  const cap = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")) }
  vi.spyOn(console, "log").mockImplementation(cap)
  vi.spyOn(console, "warn").mockImplementation(cap)
  vi.spyOn(console, "error").mockImplementation(cap)
})
afterEach(() => { vi.restoreAllMocks(); delete process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET })

describe("hubtel-send callback route", () => {
  it("exports only POST plus the Next config consts", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "maxDuration"])
    expect(route.dynamic).toBe("force-dynamic")
  })
  it("forged signature -> 401, no status check", async () => {
    const res = await route.POST(req({ ref: REF, sig: "0".repeat(64) }))
    expect(res.status).toBe(401)
    expect(h.check).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it("a signature for another purpose (collection callback) is refused", async () => {
    const res = await route.POST(req({ ref: REF, sig: signRef(REF, SECRET) }))
    expect(res.status).toBe(401)
  })
  it("missing params -> 401", async () => {
    expect((await route.POST(req({}))).status).toBe(401)
    expect((await route.POST(req({ ref: REF }))).status).toBe(401)
  })
  it("no secret configured -> 503", async () => {
    delete process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET
    expect((await route.POST(req({ ref: REF, sig: sig() }))).status).toBe(503)
    expect(h.check).not.toHaveBeenCalled()
  })
  it("a success body with a status check that says otherwise completes nothing", async () => {
    h.check.mockResolvedValue({ kind: "pending", ref: REF })
    const res = await route.POST(req({ ref: REF, sig: sig() }))
    expect(res.status).toBe(200)
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(h.rpc.mock.calls.map((c) => c[0])).not.toContain("complete_order_refund")
    expect(h.rpc.mock.calls.map((c) => c[0])).not.toContain("fail_order_refund")
  })
  it("a status check that says success completes the refund once", async () => {
    h.check.mockResolvedValue({ kind: "completed", ref: "tx9" })
    const res = await route.POST(req({ ref: REF, sig: sig() }, { ResponseCode: "4075" }))
    expect(res.status).toBe(200)
    expect(h.rpc.mock.calls.map((c) => c[0]).filter((n) => n === "complete_order_refund")).toHaveLength(1)
  })
  it("logs never contain the callback body or a phone number", async () => {
    h.check.mockResolvedValue({ kind: "completed", ref: "tx9" })
    await route.POST(req({ ref: REF, sig: sig() }))
    expect(logs.join("\n")).not.toMatch(/245550101|RecipientName/)
  })
})
