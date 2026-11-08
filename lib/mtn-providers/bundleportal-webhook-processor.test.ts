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
    external_status?: string | null
    updated_at?: string
    provider?: string
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

const flagReversalMock = vi.hoisted(() => vi.fn(async () => ({ flagged: true, superseded: false })))
vi.mock("@/lib/mtn-reversal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mtn-reversal")>()),
  flagReversal: flagReversalMock,
}))

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
    flagReversalMock.mockClear()
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

  describe("late failure after a provider-confirmed completion", () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()
    const confirmed = (ref: string, updatedHoursAgo = 2) =>
      seedTracking({ mtn_order_id: ref, status: "completed", external_status: "completed", updated_at: hoursAgo(updatedHoursAgo), provider: "bundleportal" })

    it("flags order.failed on a completed order as a reversal, passing the provider's reason", async () => {
      const target = confirmed("late-1")

      await processWebhook({ event: "order.failed", order_id: "late-1", status: "failed", failure_reason: "Delivery failed" })

      expect(flagReversalMock).toHaveBeenCalledTimes(1)
      const [, row, provider] = flagReversalMock.mock.calls[0] as unknown as [unknown, { id: string }, { status: string; message: string }]
      expect(row.id).toBe(target.id)
      expect(provider).toEqual({ status: "failed", message: "Delivery failed" })
    })

    it("flags order.refunded the same way, even when its status field is not 'failed'", async () => {
      confirmed("late-2")

      await processWebhook({ event: "order.refunded", order_id: "late-2", status: "refunded" })

      expect(flagReversalMock).toHaveBeenCalledTimes(1)
    })

    it("treats order.failed as failed even when its status field says something else", async () => {
      confirmed("late-7")

      await processWebhook({ event: "order.failed", order_id: "late-7", status: "processing" })

      expect(flagReversalMock).toHaveBeenCalledTimes(1)
    })

    it("does not also write the normal failed path, which would requeue the order", async () => {
      const target = confirmed("late-3")

      await processWebhook({ event: "order.failed", order_id: "late-3", status: "failed" })

      expect(fakeDb.updates).toEqual([])
      expect(target.status).toBe("completed")
    })

    it("does not flag a failure that arrives after the 72h window", async () => {
      const target = confirmed("late-4", 73)

      await processWebhook({ event: "order.failed", order_id: "late-4", status: "failed" })

      expect(flagReversalMock).not.toHaveBeenCalled()
      expect(target.status).toBe("completed")
    })

    it("does not flag a completion Bundle Portal never confirmed (admin-completed)", async () => {
      const target = seedTracking({ mtn_order_id: "late-5", status: "completed", external_status: null, updated_at: hoursAgo(2), provider: "bundleportal" })

      await processWebhook({ event: "order.failed", order_id: "late-5", status: "failed" })

      expect(flagReversalMock).not.toHaveBeenCalled()
      expect(target.status).toBe("completed")
    })

    it.each([
      ["order.failed", "failed"],
      ["order.completed", "completed"],
    ])("leaves an already-reversed order alone when %s is delivered again", async (event, status) => {
      const target = seedTracking({ mtn_order_id: "late-6", status: "reversed", external_status: "failed", updated_at: hoursAgo(1), provider: "bundleportal" })

      await processWebhook({ event, order_id: "late-6", status })

      expect(flagReversalMock).not.toHaveBeenCalled()
      expect(fakeDb.updates).toEqual([])
      expect(target.status).toBe("reversed")
    })
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
