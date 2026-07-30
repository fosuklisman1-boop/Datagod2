import { describe, it, expect, vi, beforeEach } from "vitest"
import { processItem } from "./agentportalgh-webhook-processor"

// Backs the fake Supabase client below. Declared via vi.hoisted so it's
// initialised before the hoisted vi.mock factory (which runs at import time)
// can reference it.
const fakeDb = vi.hoisted(() => ({
  // mtn_fulfillment_tracking rows, keyed by id. Seeded per-test.
  trackingRows: [] as Array<{
    id: string
    mtn_order_id: string | null
    status: string
    order_type: string
    order_id: string | null
    api_order_id: string | null
    shop_order_id: string | null
    recipient_phone: string
    size_gb: number | null
    provider: string
    created_at: string
  }>,
  updates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "mtn_fulfillment_tracking") {
        return {
          select: () => ({
            eq: (col: string, val: unknown) => {
              // Chainable eq() calls build up a filter; simplest correct
              // approach here is a tiny query builder that narrows fakeDb
              // rows as each .eq()/.gte()/.order()/.limit() is applied.
              let rows = fakeDb.trackingRows.filter(r => (r as Record<string, unknown>)[col] === val)
              const builder = {
                eq: (col2: string, val2: unknown) => {
                  rows = rows.filter(r => (r as Record<string, unknown>)[col2] === val2)
                  return builder
                },
                gte: (col2: string, val2: string) => {
                  rows = rows.filter(r => (r as Record<string, unknown>)[col2] as string >= val2)
                  return builder
                },
                order: () => {
                  rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
                  return builder
                },
                limit: (n: number) => {
                  rows = rows.slice(0, n)
                  return Promise.resolve({ data: rows })
                },
                maybeSingle: () => Promise.resolve({ data: rows[0] ?? null }),
              }
              return builder
            },
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
      throw new Error(`route.test.ts fake supabase client: unexpected table "${table}"`)
    },
  }),
}))

vi.mock("@/lib/phone-format", () => ({
  normalizeGhanaPhone: (phone: string) => phone, // pass-through for these tests
}))

vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn() }))

function seedTracking(overrides: Partial<(typeof fakeDb.trackingRows)[number]>) {
  const row = {
    id: `row-${fakeDb.trackingRows.length + 1}`,
    mtn_order_id: null,
    status: "processing",
    order_type: "shop",
    order_id: null,
    api_order_id: null,
    shop_order_id: null,
    recipient_phone: "0244123456",
    size_gb: 3,
    provider: "agentportalgh",
    created_at: new Date().toISOString(),
    ...overrides,
  }
  fakeDb.trackingRows.push(row)
  return row
}

describe("processItem — phone+size fallback matching", () => {
  beforeEach(() => {
    fakeDb.trackingRows = []
    fakeDb.updates = []
  })

  it("matches and completes the single candidate when phone+size is unambiguous", async () => {
    const target = seedTracking({ size_gb: 3, recipient_phone: "0244123456" })

    await processItem(
      { status: "success", msisdn: "0244123456", data_mb: 3072 },
      undefined // no reference — forces the fallback path
    )

    expect(fakeDb.updates.some(u => u.id === target.id && u.payload.status === "completed")).toBe(true)
  })

  // Regression: confirmed live — a customer's brand-new order got marked
  // "completed" moments after being created, because AgentPortalGH's queue
  // retries send a separate webhook delivery per attempt, and a stale/
  // redelivered event for an OLDER order to the same phone+size matched onto
  // the NEWEST tracking row instead (the fallback always preferred the most
  // recent match). This is the exact scenario the already-shipped
  // hasAmbiguousSibling guard in AgentPortalGHProvider.checkOrderStatus
  // (lib/mtn-providers/agentportalgh-provider.ts) protects against for the
  // cron path — this webhook path had its own separate, unprotected copy of
  // the same fallback logic.
  it("refuses to guess (leaves both orders untouched) when two tracking rows share the same phone+size in the window", async () => {
    const older = seedTracking({
      size_gb: 3, recipient_phone: "0244123456", status: "completed",
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    })
    const newer = seedTracking({
      size_gb: 3, recipient_phone: "0244123456", status: "processing",
      created_at: new Date().toISOString(), // just created
    })

    // A stale/redelivered webhook event, meant for the OLDER order, arrives
    // with no usable reference (item.reference is documented as always null
    // for this provider) — before the fix, this would match the fallback's
    // "most recent" row (the brand-new order) and mark it "completed".
    await processItem(
      { status: "success", msisdn: "0244123456", data_mb: 3072 },
      undefined
    )

    expect(fakeDb.updates).toEqual([])
    expect(older.status).toBe("completed") // unchanged
    expect(newer.status).toBe("processing") // NOT wrongly flipped to completed
  })

  it("does not fall back to an unrelated size when no candidate matches the item's actual size", async () => {
    seedTracking({ size_gb: 5, recipient_phone: "0244123456" }) // different size

    await processItem(
      { status: "success", msisdn: "0244123456", data_mb: 3072 }, // 3GB item
      undefined
    )

    expect(fakeDb.updates).toEqual([])
  })

  it("still matches directly by exact reference when available, bypassing the fallback entirely", async () => {
    const target = seedTracking({ mtn_order_id: "our-ref-123", size_gb: 3, recipient_phone: "0244123456" })
    // A second, same-phone-and-size row exists too — if the fallback were
    // consulted this would be ambiguous, but it must never be reached since
    // the reference match succeeds first.
    seedTracking({ size_gb: 3, recipient_phone: "0244123456" })

    await processItem(
      { status: "success", msisdn: "0244123456", data_mb: 3072 },
      "our-ref-123"
    )

    expect(fakeDb.updates.some(u => u.id === target.id && u.payload.status === "completed")).toBe(true)
    // Every update targeted the referenced row (webhook_received_at is
    // stamped in a separate call from the status update, both on the same
    // id) — the ambiguous sibling row must never be touched at all.
    expect(fakeDb.updates.every(u => u.id === target.id)).toBe(true)
  })

  it("uses the single phone-only candidate when the item has no size at all and there's exactly one match", async () => {
    const target = seedTracking({ recipient_phone: "0244123456", size_gb: null })

    await processItem(
      { status: "success", msisdn: "0244123456" }, // no data_mb field
      undefined
    )

    expect(fakeDb.updates.some(u => u.id === target.id && u.payload.status === "completed")).toBe(true)
  })

  it("refuses to guess when the item has no size and multiple phone-only candidates exist", async () => {
    const a = seedTracking({ recipient_phone: "0244123456", size_gb: null })
    const b = seedTracking({ recipient_phone: "0244123456", size_gb: null })

    await processItem(
      { status: "success", msisdn: "0244123456" },
      undefined
    )

    expect(fakeDb.updates).toEqual([])
    expect(a.status).toBe("processing")
    expect(b.status).toBe("processing")
  })
})
