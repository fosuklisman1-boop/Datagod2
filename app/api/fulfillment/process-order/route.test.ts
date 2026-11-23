import { describe, it, expect, vi, beforeEach } from "vitest"

// A chainable fake: every call returns the chain; awaiting it (or .single()) yields
// the order row for selects and a claimed row for the atomic-lock update.
const h = vi.hoisted(() => {
  const order = { queue: null, network: "MTN", volume_gb: 1, customer_phone: "0240000000", payment_status: "completed", order_status: "pending" }
  function chain() {
    let op = "select"
    const c: any = {}
    for (const m of ["select", "eq", "in", "limit", "order"]) c[m] = () => c
    c.update = () => { op = "update"; return c }
    c.single = async () => ({ data: order, error: null })
    c.then = (res: any, rej: any) =>
      Promise.resolve(op === "update" ? { data: [{ id: "o1" }], error: null } : { data: order, error: null }).then(res, rej)
    return c
  }
  return { createMTNOrder: vi.fn(), holdMtnOrder: vi.fn(async () => {}), client: { from: () => chain() } }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.client }))
vi.mock("@/lib/mtn-fulfillment", () => ({
  isAutoFulfillmentEnabled: async () => true,
  createMTNOrder: h.createMTNOrder,
  saveMTNTracking: vi.fn(),
  validatePhoneNetworkMatch: vi.fn(),
  normalizePhoneNumber: (p: string) => p,
}))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(), SMSTemplates: {} }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: async () => false }))
vi.mock("@/lib/mtn-providers/outcome-hold", () => ({ holdOutcomeUnknown: vi.fn(), isOutcomeUnknown: () => false }))
vi.mock("@/lib/sms/order-confirmation", () => ({
  resolveConfirmationSender: vi.fn(), resolveOwnSenderProvider: vi.fn(), sendBilledConfirmation: vi.fn(), decideConfirmationSend: vi.fn(),
}))
vi.mock("@/lib/mtn-hold", () => ({ holdMtnOrder: h.holdMtnOrder }))

import { POST } from "./route"

const req = () =>
  new Request("http://x/api/fulfillment/process-order", {
    method: "POST",
    headers: { "x-internal-secret": "s", "content-type": "application/json" },
    body: JSON.stringify({ shop_order_id: "o1", network: "MTN", phone_number: "0240000000", volume_gb: 1 }),
  }) as any

describe("process-order: held MTN orders", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.INTERNAL_API_SECRET = "s"
  })

  it("a strict hold says suppliers are checking, not 'registration'", async () => {
    h.createMTNOrder.mockResolvedValue({ success: false, held: true, error_type: "STRICT_HOLD", strictHoldReason: "unanswered", message: "held" })
    const body = await (await POST(req())).json()
    expect(body).toEqual({ success: true, message: "Order held while suppliers check this number" })
    expect(h.holdMtnOrder).toHaveBeenCalledWith(expect.objectContaining({ table: "shop_orders", orderId: "o1", errorType: "STRICT_HOLD" }))
  })

  it("a registration hold keeps its registration message", async () => {
    h.createMTNOrder.mockResolvedValue({ success: false, held: true, error_type: "NOT_REGISTERED", message: "held" })
    const body = await (await POST(req())).json()
    expect(body.message).toBe("Order held pending MTN number registration")
  })
})
