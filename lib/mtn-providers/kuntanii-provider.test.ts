import { beforeEach, describe, expect, it, vi } from "vitest"

// admin_settings fixture + recorded writes, mutable per test.
const db = vi.hoisted(() => ({
  settings: {} as Record<string, any>,
  settingsThrows: false,
  upserts: [] as Array<{ table: string; row: any; opts: any }>,
  upsertError: null as null | { message: string },
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      return {
        select() {
          return {
            eq(_col: string, key: string) {
              return {
                maybeSingle: () => {
                  if (db.settingsThrows) return Promise.reject(new Error("db down"))
                  return Promise.resolve({
                    data: db.settings[key] ? { value: db.settings[key] } : null,
                    error: null,
                  })
                },
              }
            },
          }
        },
        upsert(row: any, opts: any) {
          db.upserts.push({ table, row, opts })
          return Promise.resolve({ error: db.upsertError })
        },
      }
    },
  },
}))

const notifyMock = vi.hoisted(() => ({ notifyAdminsThrottled: vi.fn(async () => {}) }))
vi.mock("@/lib/sms/notify", () => notifyMock)

import { __resetPlanCache, type KuntaniiClient } from "./kuntanii-client"
import {
  DELIVERY_MODE_KEY,
  KuntaniiProvider,
  defaultKuntaniiAlert,
  getDeliveryMode,
} from "./kuntanii-provider"
import type { MTNOrderRequest } from "./types"

const MB = 1024
const PLANS = [1, 2, 3].map((gb, i) => ({
  planCode: i + 1,
  displayName: `${gb}GB`,
  bundleSizeMb: gb * MB,
  unitPriceGhs: gb * 4.2,
}))

const notFound = () => ({ ok: false as const, status: 404, code: "NOT_FOUND", message: "Order not found" })

function fakeClient(overrides: Partial<Record<keyof KuntaniiClient, any>> = {}) {
  const client = {
    getPricing: vi.fn(async () => ({ ok: true, status: 200, data: { deliveryMode: "normal", plans: PLANS } })),
    verifyBeneficiaries: vi.fn(async (phones: string[]) => ({
      ok: true,
      status: 200,
      data: { results: phones.map((p) => ({ phoneNumber: p, eligible: true, reason: "ok" })) },
    })),
    getOrder: vi.fn(async () => notFound()),
    placeOrder: vi.fn(async (input: any) => ({
      ok: true,
      status: 201,
      data: {
        externalOrderId: input.externalOrderId,
        outcome: "accepted",
        acceptedCount: 1,
        totalAmountGhs: 4.2,
        orderReference: "KT-0",
        status: "pending",
        orders: [{ orderReference: "KT-0", status: "pending", totalAmountGhs: 4.2 }],
      },
    })),
    reportNotReceived: vi.fn(),
    getNotReceivedStatus: vi.fn(),
    ...overrides,
  }
  return client as typeof client & KuntaniiClient
}

function setup(opts: { client?: ReturnType<typeof fakeClient>; mode?: "normal" | "instant" } = {}) {
  const client = opts.client ?? fakeClient()
  const getMode = vi.fn(async () => opts.mode ?? "normal")
  const alert = vi.fn(async () => {})
  const recordUnknownAttempt = vi.fn(async () => {})
  const provider = new KuntaniiProvider({ client, getMode, alert, recordUnknownAttempt })
  return { client, getMode, alert, recordUnknownAttempt, provider }
}

const req = (o: Partial<MTNOrderRequest> = {}): MTNOrderRequest => ({
  recipient_phone: "0241234567",
  network: "MTN",
  size_gb: 1,
  client_ref: "ord1",
  ...o,
})

const allClientCalls = (c: ReturnType<typeof fakeClient>) =>
  c.getPricing.mock.calls.length +
  c.verifyBeneficiaries.mock.calls.length +
  c.getOrder.mock.calls.length +
  c.placeOrder.mock.calls.length

beforeEach(() => {
  __resetPlanCache()
  db.settings = {}
  db.settingsThrows = false
  db.upserts = []
  db.upsertError = null
  notifyMock.notifyAdminsThrottled.mockClear()
})

describe("createOrder validation", () => {
  it("rejects non-MTN without any client call", async () => {
    const { provider, client } = setup()
    const r = await provider.createOrder(req({ network: "Telecel", recipient_phone: "0201234567" }))
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("VALIDATION")
    expect(allClientCalls(client)).toBe(0)
  })

  it("rejects a non-MTN-prefix phone without any client call", async () => {
    const { provider, client } = setup()
    const r = await provider.createOrder(req({ recipient_phone: "0201234567" }))
    expect(r.error_type).toBe("VALIDATION")
    expect(allClientCalls(client)).toBe(0)
  })

  it("rejects an unparseable phone without any client call", async () => {
    const { provider, client } = setup()
    const r = await provider.createOrder(req({ recipient_phone: "12345" }))
    expect(r.error_type).toBe("VALIDATION")
    expect(allClientCalls(client)).toBe(0)
  })

  it("normalises +233 phone and sends local format", async () => {
    const { provider, client } = setup()
    const r = await provider.createOrder(req({ recipient_phone: "+233241234567" }))
    expect(r.success).toBe(true)
    expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ phoneNumber: "0241234567" }))
    expect(client.verifyBeneficiaries).toHaveBeenCalledWith(["0241234567"])
  })
})

describe("createOrder attempt walk", () => {
  it("walk: 404 on first id places with base id", async () => {
    const { provider, client } = setup()
    const r = await provider.createOrder(req())
    expect(client.getOrder).toHaveBeenCalledWith("ord1")
    expect(client.placeOrder).toHaveBeenCalledTimes(1)
    expect(client.placeOrder).toHaveBeenCalledWith({ externalOrderId: "ord1", phoneNumber: "0241234567", dataGb: 1, mode: "normal" })
    expect(r).toMatchObject({ success: true, order_id: "ord1" })
  })

  it("walk: cancelled first attempt places ord1-r2", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async (id: string) =>
        id === "ord1"
          ? { ok: true, status: 200, data: { externalOrderId: "ord1", orders: [{ status: "cancelled" }] } }
          : notFound(),
      ),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(client.getOrder.mock.calls.map((c: any[]) => c[0])).toEqual(["ord1", "ord1-r2"])
    expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ externalOrderId: "ord1-r2" }))
    expect(r).toMatchObject({ success: true, order_id: "ord1-r2" })
  })

  it("walk: empty orders[] with top-level cancelled moves to -r2", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async (id: string) =>
        id === "ord1" ? { ok: true, status: 200, data: { externalOrderId: "ord1", orders: [], status: "cancelled" } } : notFound(),
      ),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ externalOrderId: "ord1-r2" }))
    expect(r).toMatchObject({ success: true, order_id: "ord1-r2" })
  })

  it("walk: 404 with an unexpected code fails RETRYABLE and never POSTs", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: false, status: 404, code: "ROUTE_NOT_FOUND", message: "no such route" })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.error_type).toBe("RETRYABLE")
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("walk: uncoded 404 frees the id", async () => {
    const client = fakeClient({ getOrder: vi.fn(async () => ({ ok: false, status: 404, message: "HTTP 404" })) })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r).toMatchObject({ success: true, order_id: "ord1" })
  })

  it("walk: pending existing attempt resumes without POST", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: true, status: 200, data: { externalOrderId: "ord1", orders: [{ status: "pending" }] } })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(true)
    expect(r.order_id).toBe("ord1")
    expect(r.message).toMatch(/resumed/i)
    expect(r.provider_cost_ghs).toBeUndefined()
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
    expect(client.verifyBeneficiaries).toHaveBeenCalledTimes(0)
  })

  it("walk: processed existing attempt resumes without POST (no re-delivery)", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: true, status: 200, data: { externalOrderId: "ord1", orders: [{ status: "processed" }] } })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(true)
    expect(r.order_id).toBe("ord1")
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("walk: body with only a top-level status still resumes (never places blind)", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: true, status: 200, data: { externalOrderId: "ord1", status: "processing" } })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r).toMatchObject({ success: true, order_id: "ord1" })
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("walk: lookup 500 fails RETRYABLE and never POSTs", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: false, status: 500, message: "HTTP 500" })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("RETRYABLE")
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("walk: lookup 500 does not alert", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: false, status: 500, message: "HTTP 500" })),
    })
    const { provider, alert } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.error_type).toBe("RETRYABLE")
    expect(alert).not.toHaveBeenCalled()
  })

  it("walk: lookup 401 UNAUTHORIZED alerts and fails ACCOUNT_HOLD without POST", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: false, status: 401, code: "UNAUTHORIZED", message: "Bad key" })),
    })
    const { provider, alert } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("ACCOUNT_HOLD")
    expect(alert).toHaveBeenCalledWith("kuntanii_unauthorized", "Kuntanii: orders refused", "UNAUTHORIZED: Bad key")
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("walk: lookup 403 ORDERS_PAUSED alerts and fails ACCOUNT_HOLD without POST", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: false, status: 403, code: "ORDERS_PAUSED", message: "Orders paused" })),
    })
    const { provider, alert } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.error_type).toBe("ACCOUNT_HOLD")
    expect(alert).toHaveBeenCalledWith("kuntanii_orders_paused", "Kuntanii: orders refused", "ORDERS_PAUSED: Orders paused")
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("walk: lookup network error fails RETRYABLE and never POSTs", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: false, status: 0, network: true, message: "timeout" })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.error_type).toBe("RETRYABLE")
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("walk: all attempts cancelled hits the cap with API_ERROR", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => ({ ok: true, status: 200, data: { orders: [{ status: "cancelled" }] } })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("API_ERROR")
    expect(r.message).toMatch(/attempt cap reached/)
    expect(client.getOrder.mock.calls.map((c: any[]) => c[0])).toEqual(["ord1", "ord1-r2", "ord1-r3", "ord1-r4", "ord1-r5"])
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("generates a base id when client_ref is absent", async () => {
    const { provider, client } = setup()
    const r = await provider.createOrder(req({ client_ref: undefined }))
    expect(r.success).toBe(true)
    const placedId = client.placeOrder.mock.calls[0][0].externalOrderId
    expect(placedId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.order_id).toBe(placedId)
  })
})

describe("createOrder pre-checks", () => {
  it("unsupported size skips before verify", async () => {
    const { provider, client } = setup()
    const r = await provider.createOrder(req({ size_gb: 11 }))
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("UNSUPPORTED_SIZE")
    expect(client.verifyBeneficiaries).toHaveBeenCalledTimes(0)
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("reads plans for the configured mode", async () => {
    const { provider, client } = setup({ mode: "instant" })
    await provider.createOrder(req())
    expect(client.getPricing).toHaveBeenCalledWith("instant")
    expect(client.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ mode: "instant" }))
  })

  it("pricing failure fails open", async () => {
    const client = fakeClient({ getPricing: vi.fn(async () => ({ ok: false, status: 503, message: "down" })) })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req({ size_gb: 11 }))
    expect(client.placeOrder).toHaveBeenCalledTimes(1)
    expect(r.success).toBe(true)
  })

  it("ineligible beneficiary skips", async () => {
    const client = fakeClient({
      verifyBeneficiaries: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { results: [{ phoneNumber: "0241234567", eligible: false, reason: "not_on_beneficiary_list" }] },
      })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("NOT_ELIGIBLE")
    expect(r.message).toContain("not_on_beneficiary_list")
    expect(client.placeOrder).toHaveBeenCalledTimes(0)
  })

  it("verify failure fails open", async () => {
    const client = fakeClient({
      verifyBeneficiaries: vi.fn(async () => ({ ok: false, status: 503, code: "BENEFICIARY_CHECK_UNAVAILABLE", message: "x" })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(client.placeOrder).toHaveBeenCalledTimes(1)
    expect(r.success).toBe(true)
  })
})

describe("createOrder placement", () => {
  it("instant refused is never resent as normal", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 422, code: "VALIDATION_ERROR", message: "instant not enabled" })),
    })
    const { provider, alert, recordUnknownAttempt } = setup({ client, mode: "instant" })
    const r = await provider.createOrder(req())
    expect(client.placeOrder).toHaveBeenCalledTimes(1)
    expect(client.placeOrder.mock.calls[0][0].mode).toBe("instant")
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("INSTANT_UNAVAILABLE")
    expect(alert).toHaveBeenCalledTimes(1)
    expect(recordUnknownAttempt).toHaveBeenCalledTimes(0)
  })

  it("account hold alerts with code-based type", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 403, code: "ORDERS_PAUSED", message: "Orders paused" })),
    })
    const { provider, alert } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("ACCOUNT_HOLD")
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledWith("kuntanii_orders_paused", "Kuntanii: orders refused", "ORDERS_PAUSED: Orders paused")
  })

  it("uncoded instant 422 alerts as kuntanii_instant_unavailable", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 422, message: "HTTP 422" })),
    })
    const { provider, alert } = setup({ client, mode: "instant" })
    const r = await provider.createOrder(req())
    expect(r.error_type).toBe("INSTANT_UNAVAILABLE")
    expect(alert).toHaveBeenCalledWith("kuntanii_instant_unavailable", "Kuntanii: orders refused", expect.any(String))
  })

  it("409 CONFLICT records an unknown attempt (an order with that id exists)", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 409, code: "CONFLICT", message: "conflict" })),
    })
    const { provider, recordUnknownAttempt } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(false)
    expect(recordUnknownAttempt).toHaveBeenCalledWith("ord1", "ord1")
  })

  it("unknown outcome reconcile showing cancelled fails over", async () => {
    let calls = 0
    const client = fakeClient({
      getOrder: vi.fn(async () =>
        calls++ === 0 ? notFound() : { ok: true, status: 200, data: { externalOrderId: "ord1", orders: [{ status: "cancelled" }] } },
      ),
      placeOrder: vi.fn(async () => ({ ok: false, status: 0, network: true, message: "timeout" })),
    })
    const { provider, recordUnknownAttempt } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("API_ERROR")
    expect(r.message).toMatch(/cancelled/i)
    expect(recordUnknownAttempt).toHaveBeenCalledTimes(0)
  })

  it("never logs bare phone strings from a documented 422 NO_APPROVED_RECIPIENTS body", async () => {
    const logs: string[] = []
    const spies = (["log", "warn", "error", "info"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: any[]) => {
        logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
      }),
    )
    const body = {
      success: false,
      code: "NO_APPROVED_RECIPIENTS",
      message: "No approved recipients",
      errors: { removedNewNumbers: ["0551234567", "+233 55-123-4568"] },
      rejectedRecipients: [{ phoneNumber: "0551234567", dataGb: 1, reason: "not_on_beneficiary_list" }],
      removedNewNumbers: ["233551234567"],
    }
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 422, code: "NO_APPROVED_RECIPIENTS", message: "No approved recipients", body })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    spies.forEach((s) => s.mockRestore())
    expect(r.error_type).toBe("NOT_ELIGIBLE")
    const all = logs.join("\n")
    expect(all).toContain("[KUNTANII-RAW]")
    expect(all).not.toContain("0551234567")
    expect(all).not.toContain("551234567")
    expect(all).not.toContain("55-123-4568")
  })

  it("plain validation error does not alert or record", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 422, code: "VALIDATION_ERROR", message: "bad" })),
    })
    const { provider, alert, recordUnknownAttempt } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.error_type).toBe("VALIDATION")
    expect(alert).toHaveBeenCalledTimes(0)
    expect(recordUnknownAttempt).toHaveBeenCalledTimes(0)
  })

  it("success records cost and reference", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({
        ok: true,
        status: 201,
        data: { externalOrderId: "ord1", outcome: "accepted", acceptedCount: 1, orders: [{ orderReference: "KT-1", totalAmountGhs: 11.55, status: "pending" }] },
      })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(true)
    expect(r.order_id).toBe("ord1")
    expect(r.provider_cost_ghs).toBe(11.55)
    expect(r.provider_reference).toBe("KT-1")
  })

  it("idempotent replay does not overwrite cost", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { externalOrderId: "ord1", idempotent: true, status: "pending", totalAmountGhs: 4.2, orderReference: "KT-9" },
      })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(true)
    expect(r.order_id).toBe("ord1")
    expect(r.provider_cost_ghs).toBeUndefined()
    expect(r.provider_reference).toBe("KT-9")
  })

  it("idempotent replay of cancelled is a failure", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { externalOrderId: "ord1", idempotent: true, status: "cancelled" },
      })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(false)
  })

  it("acceptedCount 0 is NOT_ELIGIBLE", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({
        ok: true,
        status: 201,
        data: { externalOrderId: "ord1", outcome: "partially_accepted", acceptedCount: 0, orders: [] },
      })),
    })
    const { provider } = setup({ client })
    const r = await provider.createOrder(req())
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("NOT_ELIGIBLE")
  })

  it("network failure records unknown attempt", async () => {
    const client = fakeClient({
      getOrder: vi.fn(async () => notFound()),
      placeOrder: vi.fn(async () => ({ ok: false, status: 0, network: true, message: "timeout" })),
    })
    const { provider, recordUnknownAttempt } = setup({ client })
    const r = await provider.createOrder(req())
    expect(recordUnknownAttempt).toHaveBeenCalledWith("ord1", "ord1")
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("RETRYABLE")
  })

  it("unknown outcome reconciles to success when the order exists", async () => {
    let calls = 0
    const client = fakeClient({
      // walk sees 404, reconcile GET after the timeout finds the order
      getOrder: vi.fn(async () => (calls++ === 0 ? notFound() : { ok: true, status: 200, data: { externalOrderId: "ord1", status: "pending" } })),
      placeOrder: vi.fn(async () => ({ ok: false, status: 0, network: true, message: "timeout" })),
    })
    const { provider, recordUnknownAttempt } = setup({ client })
    const r = await provider.createOrder(req())
    expect(client.getOrder).toHaveBeenCalledTimes(2)
    expect(client.getOrder.mock.calls[1][0]).toBe("ord1")
    expect(r).toMatchObject({ success: true, order_id: "ord1", message: "accepted (reconciled after unknown outcome)" })
    expect(r.provider_cost_ghs).toBeUndefined()
    expect(recordUnknownAttempt).toHaveBeenCalledTimes(0)
  })

  it("unknown outcome with 404 records unknown attempt and fails RETRYABLE", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 0, network: true, message: "timeout" })),
    })
    const { provider, recordUnknownAttempt } = setup({ client })
    const r = await provider.createOrder(req())
    expect(client.getOrder).toHaveBeenCalledTimes(2)
    expect(recordUnknownAttempt).toHaveBeenCalledTimes(1)
    expect(recordUnknownAttempt).toHaveBeenCalledWith("ord1", "ord1")
    expect(r).toMatchObject({ success: false, error_type: "RETRYABLE" })
  })

  it("unknown outcome on a 2xx non-JSON body also reconciles", async () => {
    let calls = 0
    const client = fakeClient({
      getOrder: vi.fn(async () => (calls++ === 0 ? notFound() : { ok: true, status: 200, data: { externalOrderId: "ord1", status: "pending" } })),
      placeOrder: vi.fn(async () => ({ ok: false, status: 201, message: "HTTP 201" })),
    })
    const { provider, recordUnknownAttempt } = setup({ client })
    const r = await provider.createOrder(req())
    expect(client.getOrder).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ success: true, order_id: "ord1" })
    expect(recordUnknownAttempt).toHaveBeenCalledTimes(0)
  })

  it("unknown outcome on a 2xx non-JSON body with failed reconcile records and fails RETRYABLE", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 200, message: "HTTP 200" })),
    })
    const { provider, recordUnknownAttempt } = setup({ client })
    const r = await provider.createOrder(req())
    expect(recordUnknownAttempt).toHaveBeenCalledWith("ord1", "ord1")
    expect(r).toMatchObject({ success: false, error_type: "RETRYABLE" })
  })

  it("plain RETRYABLE (503) records unknown attempt without a reconcile GET", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 503, code: "CREDIT_UNAVAILABLE", message: "busy" })),
    })
    const { provider, recordUnknownAttempt, alert } = setup({ client })
    const r = await provider.createOrder(req())
    expect(client.getOrder).toHaveBeenCalledTimes(1) // walk only
    expect(recordUnknownAttempt).toHaveBeenCalledWith("ord1", "ord1")
    expect(alert).toHaveBeenCalledTimes(0)
    expect(r).toMatchObject({ success: false, error_type: "RETRYABLE" })
  })

  it("records the unknown attempt with a null order id when client_ref is absent", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 429, code: "RATE_LIMITED", message: "slow down" })),
    })
    const { provider, recordUnknownAttempt } = setup({ client })
    await provider.createOrder(req({ client_ref: undefined }))
    const [extId, orderId] = recordUnknownAttempt.mock.calls[0] as unknown as [string, string | null]
    expect(extId).toMatch(/^[0-9a-f-]{36}$/)
    expect(orderId).toBeNull()
  })

  it("never logs the full phone number", async () => {
    const logs: string[] = []
    const spies = (["log", "warn", "error", "info"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: any[]) => {
        logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
      }),
    )
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({
        ok: true,
        status: 201,
        data: {
          externalOrderId: "ord1",
          acceptedCount: 1,
          orders: [{ orderReference: "KT-1", status: "pending", totalAmountGhs: 4.2, phoneNumber: "0241234567", normalizedPhone: "233241234567" } as any],
        },
      })),
    })
    const { provider } = setup({ client })
    await provider.createOrder(req())
    spies.forEach((s) => s.mockRestore())
    const all = logs.join("\n")
    expect(all).toContain("[KUNTANII-RAW]")
    expect(all).not.toContain("241234567")
  })
})

describe("checkOrderStatus", () => {
  it("checkOrderStatus maps processed → completed and passes body through", async () => {
    const body = { externalOrderId: "ord1", orders: [{ status: "processed", notReceivedStatus: null }] }
    const client = fakeClient({ getOrder: vi.fn(async () => ({ ok: true, status: 200, data: body })) })
    const { provider } = setup({ client })
    const r = await provider.checkOrderStatus("ord1")
    expect(r.success).toBe(true)
    expect(r.status).toBe("completed")
    expect(r.order).toEqual(body)
  })

  it("redacts phones in the returned order body but keeps status fields", async () => {
    const body = {
      externalOrderId: "ord1",
      status: "processed",
      orders: [
        {
          orderReference: "KT-1",
          status: "processed",
          phoneNumber: "0241234567",
          notReceivedStatus: "open",
          removedNewNumbers: ["0241234567"],
        },
      ],
    }
    const client = fakeClient({ getOrder: vi.fn(async () => ({ ok: true, status: 200, data: body })) })
    const { provider } = setup({ client })
    const r = await provider.checkOrderStatus("ord1")
    expect(JSON.stringify(r.order)).not.toContain("0241234567")
    expect(r.order.status).toBe("processed")
    expect(r.order.orders[0].status).toBe("processed")
    expect(r.order.orders[0].orderReference).toBe("KT-1")
    expect(r.order.orders[0].notReceivedStatus).toBe("open")
  })

  it("maps a top-level status when orders[] is absent", async () => {
    const client = fakeClient({ getOrder: vi.fn(async () => ({ ok: true, status: 200, data: { status: "cancelled" } })) })
    const { provider } = setup({ client })
    const r = await provider.checkOrderStatus("ord1")
    expect(r.status).toBe("failed")
  })

  it("FAILED_INIT_ ids are failed with no client call", async () => {
    const { provider, client } = setup()
    const r = await provider.checkOrderStatus("FAILED_INIT_x")
    expect(r.status).toBe("failed")
    expect(allClientCalls(client)).toBe(0)
  })

  it("404 is success:false (not failed)", async () => {
    const { provider } = setup()
    const r = await provider.checkOrderStatus("ord1")
    expect(r.success).toBe(false)
    expect(r.status).toBeUndefined()
  })

  it("other errors are success:false", async () => {
    const client = fakeClient({ getOrder: vi.fn(async () => ({ ok: false, status: 500, message: "HTTP 500" })) })
    const { provider } = setup({ client })
    const r = await provider.checkOrderStatus("ord1")
    expect(r.success).toBe(false)
  })
})

describe("misc", () => {
  it("checkBalance returns null", async () => {
    const { provider, client } = setup()
    expect(await provider.checkBalance()).toBeNull()
    expect(allClientCalls(client)).toBe(0)
  })

  it("name is kuntanii", () => {
    expect(setup().provider.name).toBe("kuntanii")
  })
})

describe("getDeliveryMode", () => {
  it("uses the documented key", () => {
    expect(DELIVERY_MODE_KEY).toBe("kuntanii_delivery_mode")
  })
  it("defaults to normal when unset", async () => {
    expect(await getDeliveryMode()).toBe("normal")
  })
  it("returns instant when configured", async () => {
    db.settings = { kuntanii_delivery_mode: { mode: "instant" } }
    expect(await getDeliveryMode()).toBe("instant")
  })
  it("treats garbage as normal", async () => {
    db.settings = { kuntanii_delivery_mode: { mode: "turbo" } }
    expect(await getDeliveryMode()).toBe("normal")
  })
  it("read error falls back to normal", async () => {
    db.settingsThrows = true
    expect(await getDeliveryMode()).toBe("normal")
  })
})

describe("defaults", () => {
  it("defaultKuntaniiAlert uses notifyAdminsThrottled with the mtn settings url and 1h throttle", async () => {
    await defaultKuntaniiAlert("kuntanii_orders_paused", "T", "M")
    expect(notifyMock.notifyAdminsThrottled).toHaveBeenCalledWith("kuntanii_orders_paused", "T", "M", "/admin/settings/mtn", 3_600_000)
  })

  it("default recordUnknownAttempt upserts into kuntanii_unknown_attempts ignoring duplicates", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 503, code: "CREDIT_UNAVAILABLE", message: "busy" })),
    })
    const provider = new KuntaniiProvider({ client, getMode: async () => "normal", alert: async () => {} })
    await provider.createOrder(req())
    expect(db.upserts).toEqual([
      {
        table: "kuntanii_unknown_attempts",
        row: { external_order_id: "ord1", order_id: "ord1" },
        opts: { onConflict: "external_order_id", ignoreDuplicates: true },
      },
    ])
  })

  it("default recordUnknownAttempt swallows insert errors", async () => {
    db.upsertError = { message: "boom" }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 503, code: "CREDIT_UNAVAILABLE", message: "busy" })),
    })
    const provider = new KuntaniiProvider({ client, getMode: async () => "normal", alert: async () => {} })
    const r = await provider.createOrder(req())
    warn.mockRestore()
    expect(r).toMatchObject({ success: false, error_type: "RETRYABLE" })
  })

  it("a throwing alert does not change the result", async () => {
    const client = fakeClient({
      placeOrder: vi.fn(async () => ({ ok: false, status: 402, code: "INSUFFICIENT_CREDIT", message: "no credit" })),
    })
    const provider = new KuntaniiProvider({
      client,
      getMode: async () => "normal",
      alert: async () => {
        throw new Error("notify down")
      },
      recordUnknownAttempt: async () => {},
    })
    const r = await provider.createOrder(req())
    expect(r).toMatchObject({ success: false, error_type: "ACCOUNT_HOLD" })
  })
})
