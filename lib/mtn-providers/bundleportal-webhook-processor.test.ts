import { describe, it, expect, vi, beforeEach } from "vitest"
import crypto from "crypto"
import { verifySig } from "./bundleportal-webhook-processor"

describe("verifySig", () => {
  const secret = "whsec_test_secret"
  const body = JSON.stringify({ event: "order.completed", order_id: "abc-123" })

  it("accepts a correctly signed body", () => {
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
    expect(verifySig(body, sig, secret)).toBe(true)
  })

  it("rejects a tampered body", () => {
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
    expect(verifySig(body + "tampered", sig, secret)).toBe(false)
  })

  it("rejects a missing signature header", () => {
    expect(verifySig(body, null, secret)).toBe(false)
  })

  it("rejects a signature signed with the wrong secret", () => {
    const sig = "sha256=" + crypto.createHmac("sha256", "wrong_secret").update(body).digest("hex")
    expect(verifySig(body, sig, secret)).toBe(false)
  })
})

const fakeDb = vi.hoisted(() => ({
  trackingRows: [] as Array<{
    id: string
    mtn_order_id: string | null
    status: string
    order_type: string
    order_id: string | null
    api_order_id: string | null
    shop_order_id: string | null
  }>,
  updates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "mtn_fulfillment_tracking") {
        return {
          select: () => ({
            eq: (col: string, val: unknown) => ({
              maybeSingle: () => Promise.resolve({ data: fakeDb.trackingRows.find(r => (r as Record<string, unknown>)[col] === val) ?? null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              fakeDb.updates.push({ id, payload })
              const row = fakeDb.trackingRows.find(r => r.id === id)
              if (row) Object.assign(row, payload)
              return Promise.resolve({ data: null, error: null })
            },
          }),
        }
      }
      if (table === "orders" || table === "api_orders" || table === "ussd_orders" || table === "ussd_shop_orders" || table === "shop_orders") {
        return {
          update: () => ({
            eq: () => ({
              select: () => ({ single: () => Promise.resolve({ data: null }) }),
            }),
          }),
        }
      }
      throw new Error(`bundleportal-webhook-processor.test.ts fake supabase client: unexpected table "${table}"`)
    },
  }),
}))

vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn() }))

import { processWebhook } from "./bundleportal-webhook-processor"

function seedTracking(overrides: Partial<(typeof fakeDb.trackingRows)[number]>) {
  const row = {
    id: `row-${fakeDb.trackingRows.length + 1}`,
    mtn_order_id: null,
    status: "processing",
    order_type: "shop",
    order_id: null,
    api_order_id: null,
    shop_order_id: null,
    ...overrides,
  }
  fakeDb.trackingRows.push(row)
  return row
}

describe("processWebhook", () => {
  beforeEach(() => {
    fakeDb.trackingRows = []
    fakeDb.updates = []
  })

  it("looks up the tracking row directly by order_id (our own reference) and marks it completed", async () => {
    const target = seedTracking({ mtn_order_id: "our-ref-1" })

    await processWebhook({ event: "order.completed", order_id: "our-ref-1", status: "completed" })

    expect(fakeDb.updates.some(u => u.id === target.id && u.payload.status === "completed")).toBe(true)
  })

  it("does nothing when no tracking row matches the order_id", async () => {
    await processWebhook({ event: "order.failed", order_id: "unknown-ref", status: "failed" })
    expect(fakeDb.updates).toEqual([])
  })

  it("does nothing when the payload has no order_id at all", async () => {
    await processWebhook({ event: "order.completed", status: "completed" })
    expect(fakeDb.updates).toEqual([])
  })

  it("never regresses a completed order back to processing", async () => {
    const target = seedTracking({ mtn_order_id: "our-ref-2", status: "completed" })

    await processWebhook({ event: "order.cancelled", order_id: "our-ref-2", status: "processing" })

    expect(fakeDb.updates.every(u => u.payload.status !== "processing")).toBe(true)
    expect(target.status).toBe("completed")
  })

  it("never regresses a failed order back to processing (failed is terminal for Bundle Portal)", async () => {
    const target = seedTracking({ mtn_order_id: "our-ref-3", status: "failed" })

    await processWebhook({ event: "order.completed", order_id: "our-ref-3", status: "processing" })

    expect(fakeDb.updates.every(u => u.payload.status !== "processing")).toBe(true)
    expect(target.status).toBe("failed")
  })

  it("maps cancelled and refunded events to failed", async () => {
    const cancelled = seedTracking({ mtn_order_id: "our-ref-4" })
    await processWebhook({ event: "order.cancelled", order_id: "our-ref-4", status: "failed" })
    expect(cancelled.status).toBe("failed")

    const refunded = seedTracking({ mtn_order_id: "our-ref-5" })
    await processWebhook({ event: "order.refunded", order_id: "our-ref-5", status: "failed" })
    expect(refunded.status).toBe("failed")
  })

  it("re-delivering the SAME terminal status only stamps webhook_received_at, nothing else", async () => {
    const target = seedTracking({ mtn_order_id: "our-ref-6", status: "completed" })

    await processWebhook({ event: "order.completed", order_id: "our-ref-6", status: "completed" })

    expect(fakeDb.updates).toHaveLength(1)
    expect(fakeDb.updates[0].id).toBe(target.id)
    expect(Object.keys(fakeDb.updates[0].payload)).toEqual(["webhook_received_at"])
    expect(target.status).toBe("completed")
  })
})
