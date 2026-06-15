import { vi, beforeEach } from "vitest"

// Mock the I/O edges so the drain logic runs against a controllable fake DB.
const sendMock = vi.fn(async () => "wamid-123" as string | null)
vi.mock("@/lib/whatsapp-bot/send", () => ({ sendWhatsAppText: (...a: unknown[]) => sendMock(...(a as [])) }))
vi.mock("@/lib/whatsapp-bot/log-message", () => ({ logMessage: vi.fn(async () => ({})) }))

import { drainDeliveryNotifications } from "@/lib/wa-delivery-notify"

const ORDER_TABLES = new Set(["orders", "shop_orders", "ussd_orders", "ussd_shop_orders", "airtime_orders"])

interface FakeOpts {
  claimRows: Array<{ id: string; order_table: string; order_id: string; status: string; attempts: number }>
  orderRows?: Record<string, Record<string, unknown>> // table -> id -> row
  users?: Record<string, { phone_number: string | null }>
  warmRows?: Array<{ phone_number: string }>
  warmError?: boolean
}

/** Minimal chainable Supabase stand-in: records every .update() it receives. */
function fakeClient(opts: FakeOpts) {
  const updates: Array<{ table: string; payload: Record<string, unknown>; filters: Record<string, unknown> }> = []

  function resolve(table: string, payload: Record<string, unknown> | null, filters: Record<string, unknown>) {
    if (payload) {
      updates.push({ table, payload, filters })
      return { data: null, error: null }
    }
    if (ORDER_TABLES.has(table)) return { data: opts.orderRows?.[table]?.[filters.id as string] ?? null, error: null }
    if (table === "users") return { data: opts.users?.[filters.id as string] ?? null, error: null }
    if (table === "whatsapp_conversations") {
      return opts.warmError ? { data: null, error: { message: "boom" } } : { data: opts.warmRows ?? [], error: null }
    }
    return { data: null, error: null }
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const state = { payload: null as Record<string, unknown> | null, filters: {} as Record<string, unknown> }
    const passthrough = () => b
    b.select = passthrough
    b.insert = passthrough
    b.lt = passthrough
    b.gte = passthrough
    b.update = (p: Record<string, unknown>) => { state.payload = p; return b }
    b.eq = (c: string, v: unknown) => { state.filters[c] = v; return b }
    b.in = (c: string, v: unknown) => { state.filters["in:" + c] = v; return b }
    b.maybeSingle = async () => resolve(table, state.payload, state.filters)
    // Thenable: `await from(...).update(...).eq(...)` resolves here.
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(table, state.payload, state.filters)).then(onF, onR)
    return b
  }

  const client = {
    rpc: vi.fn(async (name: string) => (name === "claim_wa_delivery" ? { data: opts.claimRows, error: null } : { data: null, error: null })),
    from: (table: string) => builder(table),
  }
  return { client, updates }
}

const ORDER = { user_id: null, phone_number: "0241234567", network: "MTN", size: "5GB" }

beforeEach(() => {
  sendMock.mockReset()
  sendMock.mockResolvedValue("wamid-123")
})

describe("drainDeliveryNotifications", () => {
  it("sends to a warm purchaser and marks the row sent", async () => {
    const { client, updates } = fakeClient({
      claimRows: [{ id: "o1", order_table: "orders", order_id: "ord1", status: "processing", attempts: 1 }],
      orderRows: { orders: { ord1: ORDER } },
      warmRows: [{ phone_number: "233241234567" }],
    })
    const r = await drainDeliveryNotifications(client as never)
    expect(r.sent).toBe(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(updates.some((u) => u.filters.id === "o1" && u.payload.status === "sent")).toBe(true)
  })

  it("skips a cold purchaser as skipped_cold without sending", async () => {
    const { client, updates } = fakeClient({
      claimRows: [{ id: "o1", order_table: "orders", order_id: "ord1", status: "processing", attempts: 1 }],
      orderRows: { orders: { ord1: ORDER } },
      warmRows: [], // no warm conversation
    })
    const r = await drainDeliveryNotifications(client as never)
    expect(r.skippedCold).toBe(1)
    expect(sendMock).not.toHaveBeenCalled()
    expect(updates.some((u) => u.filters.id === "o1" && u.payload.status === "skipped_cold")).toBe(true)
  })

  it("skips an order with no resolvable purchaser phone", async () => {
    const { client } = fakeClient({
      claimRows: [{ id: "o1", order_table: "orders", order_id: "ord1", status: "processing", attempts: 1 }],
      orderRows: { orders: { ord1: { user_id: null, phone_number: null, network: "MTN", size: "5GB" } } },
      warmRows: [],
    })
    const r = await drainDeliveryNotifications(client as never)
    expect(r.skipped).toBe(1)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("un-claims the whole batch (no terminal skip) when the warm lookup errors", async () => {
    const { client, updates } = fakeClient({
      claimRows: [{ id: "o1", order_table: "orders", order_id: "ord1", status: "processing", attempts: 1 }],
      orderRows: { orders: { ord1: ORDER } },
      warmError: true,
    })
    const r = await drainDeliveryNotifications(client as never)
    expect(r.sent).toBe(0)
    expect(r.skippedCold).toBe(0)
    expect(sendMock).not.toHaveBeenCalled()
    // Batch handed back to the queue for retry: an update setting pending, keyed by in:id.
    expect(updates.some((u) => u.payload.status === "pending" && Array.isArray(u.filters["in:id"]))).toBe(true)
  })

  it("marks the row failed when the send returns null", async () => {
    sendMock.mockResolvedValueOnce(null)
    const { client, updates } = fakeClient({
      claimRows: [{ id: "o1", order_table: "orders", order_id: "ord1", status: "processing", attempts: 1 }],
      orderRows: { orders: { ord1: ORDER } },
      warmRows: [{ phone_number: "233241234567" }],
    })
    const r = await drainDeliveryNotifications(client as never)
    expect(r.failed).toBe(1)
    expect(updates.some((u) => u.filters.id === "o1" && u.payload.status === "failed")).toBe(true)
  })
})
