import { describe, expect, it, vi } from "vitest"

const fetchRefund = vi.fn()
vi.mock("@/lib/paystack", () => ({ refundTransaction: vi.fn(), fetchRefund: (...a: unknown[]) => fetchRefund(...a) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { inspectGatewayStatus } from "./gateway-status"
import { getGateway } from "./gateways"
import type { RefundDeps, StoredRefund } from "./service"

const stored = (o: Partial<StoredRefund> = {}): StoredRefund => ({
  id: "rf-1", order_table: "ussd_orders", order_id: "o1", gateway: "paystack", amount: 9.5,
  destination_phone: null, gateway_ref: "99", status: "completed", clawbacks: [], updated_at: "2026-10-05T00:00:00Z", ...o,
})
const deps = () => ({
  rpc: vi.fn(), loadOrder: vi.fn().mockResolvedValue(null), getGateway, notify: vi.fn(),
}) as unknown as RefundDeps & { rpc: ReturnType<typeof vi.fn> }

describe("inspectGatewayStatus", () => {
  it("returns the gateway kind + raw status and writes nothing", async () => {
    fetchRefund.mockResolvedValue({ id: 99, status: "failed" })
    const d = deps()
    const r = await inspectGatewayStatus(d, stored())
    expect(r).toMatchObject({ refundId: "rf-1", ledgerStatus: "completed", gatewayStatus: "failed", rawStatus: "failed" })
    expect(d.rpc).not.toHaveBeenCalled()
  })
  it("no gateway_ref => gatewayStatus null, no lookup", async () => {
    fetchRefund.mockClear()
    const r = await inspectGatewayStatus(deps(), stored({ gateway_ref: null }))
    expect(r.gatewayStatus).toBeNull()
    expect(fetchRefund).not.toHaveBeenCalled()
  })
  it("wallet is never verified (its checkStatus credits money)", async () => {
    const d = deps()
    const r = await inspectGatewayStatus(d, stored({ gateway: "wallet", gateway_ref: "w1" }))
    expect(r.gatewayStatus).toBeNull()
    expect(d.loadOrder).not.toHaveBeenCalled()
  })
  it("a lookup error is unknown, never failed", async () => {
    fetchRefund.mockRejectedValue(Object.assign(new Error("nope"), { httpStatus: 404 }))
    expect((await inspectGatewayStatus(deps(), stored())).gatewayStatus).toBe("unknown")
  })
})
