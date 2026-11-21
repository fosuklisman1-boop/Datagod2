import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
const notifyMock = vi.hoisted(() => ({ notifyAdminsThrottled: vi.fn(async () => {}) }))
vi.mock("@/lib/sms/notify", () => notifyMock)

import { HubnetProvider, defaultHubnetAlert } from "./hubnet-provider"
import { hubnetRef } from "@/lib/hubnet/core"
import type { HubnetClient } from "@/lib/hubnet/client"
import type { StatusLookup } from "@/lib/hubnet/core"
import type { MTNOrderRequest } from "./types"

const UUID = "123e4567-e89b-42d3-a456-426614174000"
const ref = (n: number) => hubnetRef("data", UUID, n)

const missing: StatusLookup = { kind: "missing" }
const unknown: StatusLookup = { kind: "unknown" }
const found = (status: "processing" | "completed" | "failed", refunded = false, raw: unknown = {}): StatusLookup => ({
  kind: "found",
  status,
  refunded,
  raw,
})

const placed = () => ({
  ok: true as const,
  res: { status: 200 } as Response,
  json: { event: "charge.success" },
  text: "",
})
const reply = (status: number, json: unknown) => ({ ok: true as const, res: { status } as Response, json, text: "" })

function fakeClient(opts: {
  status?: (ref: string) => StatusLookup
  place?: () => any
} = {}) {
  const getStatus = vi.fn(async (r: string) => (opts.status ? opts.status(r) : missing))
  const placeData = vi.fn(async (..._a: any[]) => (opts.place ? opts.place() : placed()))
  const client = {
    getStatus,
    placeData,
    placeAirtime: vi.fn(),
    listRefunds: vi.fn(),
    getBalance: vi.fn(async () => 12.5),
    verifyMtn: vi.fn(),
  } as unknown as HubnetClient
  return { client, getStatus, placeData }
}

function make(client: HubnetClient, configured = true) {
  const alert = vi.fn(async (_t: string, _ti: string, _m: string) => {})
  const provider = new HubnetProvider({ client, alert, configured: () => configured })
  return { provider, alert }
}

const mtnReq: MTNOrderRequest = { recipient_phone: "0241234567", network: "MTN", size_gb: 2, client_ref: UUID }

describe("HubnetProvider.createOrder", () => {
  it("routes MTN / AT / AT BigTime / Telecel to the matching endpoint", async () => {
    const cases: Array<[Partial<MTNOrderRequest>, string]> = [
      [{}, "mtn"],
      [{ network: "AirtelTigo", recipient_phone: "0261234567" }, "at"],
      [{ network: "AirtelTigo", recipient_phone: "0261234567", isBigTime: true }, "big-time"],
      [{ network: "Telecel", recipient_phone: "0201234567" }, "telecel"],
    ]
    for (const [over, net] of cases) {
      const f = fakeClient()
      const r = await make(f.client).provider.createOrder({ ...mtnReq, ...over })
      expect(r.success).toBe(true)
      expect(f.placeData.mock.calls[0][0]).toBe(net)
    }
  })

  it("prefix mismatch never calls Hubnet", async () => {
    const f = fakeClient()
    const r = await make(f.client).provider.createOrder({ ...mtnReq, recipient_phone: "0201234567" })
    expect(r.success).toBe(false)
    expect(f.getStatus).not.toHaveBeenCalled()
    expect(f.placeData).not.toHaveBeenCalled()
  })

  it("missing or non-uuid client_ref fails without calling Hubnet", async () => {
    for (const client_ref of [undefined, "ord-1"]) {
      const f = fakeClient()
      const r = await make(f.client).provider.createOrder({ ...mtnReq, client_ref })
      expect(r).toMatchObject({ success: false, message: "Hubnet: no order reference", error_type: "API_ERROR" })
      expect(f.getStatus).not.toHaveBeenCalled()
      expect(f.placeData).not.toHaveBeenCalled()
    }
  })

  it("unconfigured fails without any network call", async () => {
    const f = fakeClient()
    const r = await make(f.client, false).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: false, message: "Hubnet not configured" })
    expect(f.getStatus).not.toHaveBeenCalled()
    expect(f.placeData).not.toHaveBeenCalled()
  })

  it("fresh order: ref1 missing => places ref1 with volumeMb = size_gb*1000", async () => {
    const f = fakeClient()
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: true, order_id: ref(1) })
    expect(f.placeData).toHaveBeenCalledTimes(1)
    expect(f.placeData).toHaveBeenCalledWith("mtn", { phone: "0241234567", volumeMb: 2000, reference: ref(1) })
  })

  it("existing attempt adopted without placing", async () => {
    for (const st of ["processing", "completed"] as const) {
      const f = fakeClient({ status: () => found(st) })
      const r = await make(f.client).provider.createOrder(mtnReq)
      expect(r).toMatchObject({ success: true, order_id: ref(1) })
      expect(f.placeData).not.toHaveBeenCalled()
    }
  })

  it("failed attempt advances to ref2", async () => {
    const f = fakeClient({ status: (r) => (r === ref(1) ? found("failed") : missing) })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: true, order_id: ref(2) })
    expect(f.placeData.mock.calls[0][1].reference).toBe(ref(2))
  })

  it("refunded attempt advances even if status says completed", async () => {
    const f = fakeClient({ status: (r) => (r === ref(1) ? found("completed", true) : missing) })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: true, order_id: ref(2) })
  })

  it("all 5 failed => failure, no placement", async () => {
    const f = fakeClient({ status: () => found("failed") })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: false, message: "Hubnet: all 5 attempts used" })
    expect(r.error_type).not.toBe("OUTCOME_UNKNOWN")
    expect(f.placeData).not.toHaveBeenCalled()
  })

  it("ambiguous status lookup never places", async () => {
    const f = fakeClient({ status: () => unknown })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(f.placeData).not.toHaveBeenCalled()
  })

  it("unknown on attempt 2 after failed attempt 1 never places", async () => {
    const f = fakeClient({ status: (r) => (r === ref(1) ? found("failed") : unknown) })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(f.placeData).not.toHaveBeenCalled()
  })

  it("409 duplicate adopts the existing attempt", async () => {
    let calls = 0
    const f = fakeClient({
      status: () => (calls++ === 0 ? missing : found("processing")),
      place: () => reply(409, { message: "duplicate" }),
    })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: true, order_id: ref(1) })
    expect(f.placeData).toHaveBeenCalledTimes(1)
  })

  it("409 duplicate whose re-check is not found is OUTCOME_UNKNOWN", async () => {
    for (const second of [missing, unknown, found("failed")]) {
      let calls = 0
      const f = fakeClient({
        status: () => (calls++ === 0 ? missing : second),
        place: () => reply(409, {}),
      })
      const r = await make(f.client).provider.createOrder(mtnReq)
      expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    }
  })

  it("place unknown (OUTCOME_UNKNOWN response) + re-check found => success", async () => {
    let calls = 0
    const f = fakeClient({
      status: () => (calls++ === 0 ? missing : found("processing")),
      place: () => ({ ok: false, response: { success: false, message: "x", error_type: "OUTCOME_UNKNOWN" } }),
    })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: true, order_id: ref(1) })
  })

  it("place unknown (5xx classified) + re-check found => success", async () => {
    let calls = 0
    const f = fakeClient({
      status: () => (calls++ === 0 ? missing : found("completed")),
      place: () => reply(502, { message: "bad" }),
    })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: true, order_id: ref(1) })
  })

  it("place throws + re-check missing or unknown => OUTCOME_UNKNOWN", async () => {
    for (const second of [missing, unknown]) {
      let calls = 0
      const f = fakeClient({
        status: () => (calls++ === 0 ? missing : second),
        place: () => {
          throw new Error("boom")
        },
      })
      const r = await make(f.client).provider.createOrder(mtnReq)
      expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    }
  })

  it("place unknown + re-check found failed => plain failure", async () => {
    let calls = 0
    const f = fakeClient({
      status: () => (calls++ === 0 ? missing : found("failed")),
      place: () => reply(500, {}),
    })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("API_ERROR")
  })

  it("a definitive non-unknown failure response from the client is returned as is", async () => {
    const response = { success: false, message: "Hubnet HTTP 404 (non-JSON response)", error_type: "API_ERROR" }
    const f = fakeClient({ place: () => ({ ok: false, response }) })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toBe(response)
  })

  it("insufficient balance => INSUFFICIENT_BALANCE and a hubnet_low_balance alert", async () => {
    const f = fakeClient({ place: () => reply(400, { status_code: 402, message: "Insufficient balance" }) })
    const { provider, alert } = make(f.client)
    const r = await provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: false, error_type: "INSUFFICIENT_BALANCE" })
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0][0]).toBe("hubnet_low_balance")
  })

  it("auth => hubnet_auth alert + failure; alert text has no phone", async () => {
    const f = fakeClient({ place: () => reply(401, { message: "Unauthorized" }) })
    const { provider, alert } = make(f.client)
    const r = await provider.createOrder(mtnReq)
    expect(r.success).toBe(false)
    expect(alert.mock.calls[0][0]).toBe("hubnet_auth")
    expect(alert.mock.calls[0].join(" ")).not.toContain("0241234567")
  })

  it("rejected => plain API_ERROR failure, no alert", async () => {
    const f = fakeClient({ place: () => reply(403, { message: "no" }) })
    const { provider, alert } = make(f.client)
    const r = await provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: false, error_type: "API_ERROR" })
    expect(alert).not.toHaveBeenCalled()
  })

  it("order POST 429 => RATE_LIMIT ordinary failure (not sent), never OUTCOME_UNKNOWN, no alert", async () => {
    const f = fakeClient({ place: () => reply(429, {}) })
    const { provider, alert } = make(f.client)
    const r = await provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: false, error_type: "RATE_LIMIT" })
    expect(alert).not.toHaveBeenCalled()
  })

  // Incident 2026-11-21 18:56: ~56 orders held OUTCOME_UNKNOWN because pre-place lookups got 429.
  it("pre-place lookup rate_limited => RATE_LIMIT failure; never places, never holds", async () => {
    const f = fakeClient({ status: () => ({ kind: "rate_limited", retryAfterSec: 60 }) })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: false, error_type: "RATE_LIMIT" })
    expect(r.error_type).not.toBe("OUTCOME_UNKNOWN")
    expect(r.message).toContain("60s")
    expect(f.placeData).not.toHaveBeenCalled()
  })

  it("rate_limited on a later attempt's lookup also stops without placing", async () => {
    const f = fakeClient({ status: (r) => (r === ref(1) ? found("failed") : { kind: "rate_limited", retryAfterSec: 30 }) })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r).toMatchObject({ success: false, error_type: "RATE_LIMIT" })
    expect(f.placeData).not.toHaveBeenCalled()
  })

  it("a lookup kind it does not know never places (holds instead)", async () => {
    const f = fakeClient({ status: () => ({ kind: "something_new" }) as unknown as StatusLookup })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(f.placeData).not.toHaveBeenCalled()
  })

  it("after an unknown place reply, a rate_limited reconcile lookup still holds (may have been placed)", async () => {
    let calls = 0
    const f = fakeClient({
      status: () => (calls++ === 0 ? missing : { kind: "rate_limited", retryAfterSec: 60 }),
      place: () => reply(503, {}),
    })
    const r = await make(f.client).provider.createOrder(mtnReq)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
  })

  it("a throwing alert never changes the outcome", async () => {
    const f = fakeClient({ place: () => reply(401, {}) })
    const provider = new HubnetProvider({
      client: f.client,
      alert: async () => {
        throw new Error("alert down")
      },
      configured: () => true,
    })
    const r = await provider.createOrder(mtnReq)
    expect(r.success).toBe(false)
  })
})

describe("HubnetProvider.checkOrderStatus", () => {
  it("maps found statuses and exposes raw status + refunded", async () => {
    for (const st of ["completed", "processing", "failed"] as const) {
      const f = fakeClient({ status: () => found(st, false, { data: { delivery_status: "Whatever" } }) })
      const r = await make(f.client).provider.checkOrderStatus(ref(1))
      expect(r.success).toBe(true)
      expect(r.status).toBe(st)
      expect(r.order).toMatchObject({ status: "Whatever", refunded: false })
    }
  })

  it("refunded maps to failed with refunded true", async () => {
    const f = fakeClient({ status: () => found("failed", true, { status: "refunded" }) })
    const r = await make(f.client).provider.checkOrderStatus(ref(1))
    expect(r).toMatchObject({ success: true, status: "failed" })
    expect(r.order.refunded).toBe(true)
  })

  it("missing / unknown => success false (never a status)", async () => {
    for (const st of [missing, unknown]) {
      const f = fakeClient({ status: () => st })
      const r = await make(f.client).provider.checkOrderStatus(ref(1))
      expect(r.success).toBe(false)
      expect(r.status).toBeUndefined()
    }
  })

  it("UNKNOWN_ ids short-circuit with no lookup", async () => {
    const f = fakeClient()
    const r = await make(f.client).provider.checkOrderStatus("UNKNOWN_123")
    expect(r.success).toBe(false)
    expect(f.getStatus).not.toHaveBeenCalled()
  })

  it("checkBalance returns null without a network call when unconfigured", async () => {
    const f = fakeClient()
    expect(await make(f.client, false).provider.checkBalance()).toBeNull()
    expect(f.client.getBalance).not.toHaveBeenCalled()
  })

  it("checkBalance returns the client balance", async () => {
    const f = fakeClient()
    expect(await make(f.client).provider.checkBalance()).toBe(12.5)
  })
})

describe("defaultHubnetAlert", () => {
  it("throttles per type for an hour", async () => {
    await defaultHubnetAlert("hubnet_auth", "t", "m")
    expect(notifyMock.notifyAdminsThrottled).toHaveBeenCalledWith("hubnet_auth", "t", "m", expect.any(String), 3_600_000)
  })
})
