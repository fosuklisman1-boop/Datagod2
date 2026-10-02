import { describe, it, expect, vi, beforeEach } from "vitest"

const fakeDb = vi.hoisted(() => ({
  tracking: null as any,
  orderRow: { user_id: "user-1", phone_number: "0551234567", size: "10GB" } as any,
  updates: [] as any[],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: () => Promise.resolve({ data: fakeDb.tracking, error: null }) }
            },
          }
        },
        update(patch: any) {
          fakeDb.updates.push({ table, patch })
          // eq() must serve both plain awaits (tracking-table updates) and the
          // chained .select().single() used by the order-table update branches.
          const eqResult: any = Promise.resolve({ data: null, error: null })
          eqResult.select = () => ({
            single: () => Promise.resolve({ data: fakeDb.orderRow, error: null }),
          })
          return { eq: () => eqResult }
        },
      }
    },
  }),
}))

import { verifyToken, processWebhook } from "./spfastit-telecel-webhook-processor"

beforeEach(() => {
  fakeDb.tracking = null
  fakeDb.updates = []
})

describe("verifyToken", () => {
  it("accepts a matching token", () => {
    expect(verifyToken("secret123", "secret123")).toBe(true)
  })
  it("rejects a missing or mismatched token", () => {
    expect(verifyToken(null, "secret123")).toBe(false)
    expect(verifyToken("wrong", "secret123")).toBe(false)
  })
})

describe("processWebhook", () => {
  it("does nothing when no tracking row matches order_id", async () => {
    fakeDb.tracking = null
    await processWebhook({ order_id: 646856, status: "completed" })
    expect(fakeDb.updates).toHaveLength(0)
  })

  it("updates the tracking row when a match is found", async () => {
    fakeDb.tracking = { id: "row-1", status: "processing", order_type: "bulk", order_id: "order-uuid", api_order_id: null, shop_order_id: null }
    await processWebhook({ order_id: 646856, status: "completed", message: "Order updated to status: Completed" })
    expect(fakeDb.updates.some(u => u.table === "mtn_fulfillment_tracking" && u.patch.status === "completed")).toBe(true)
  })
})
