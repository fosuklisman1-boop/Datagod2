import { describe, it, expect, vi, beforeEach } from "vitest"
import { processItems } from "./agentportalgh-webhook-processor"

const fakeDb = vi.hoisted(() => ({
  trackingRows: [] as Array<Record<string, any>>,
  updates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
  fetchAll: null as null | ((orderId: string) => Promise<any[]>),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "mtn_fulfillment_tracking") {
        return {
          select: () => ({
            eq: (col: string, val: unknown) => {
              let rows = fakeDb.trackingRows.filter(r => r[col] === val)
              const builder: any = {
                eq: (c: string, v: unknown) => { rows = rows.filter(r => r[c] === v); return builder },
                gte: (c: string, v: string) => { rows = rows.filter(r => (r[c] as string) >= v); return builder },
                order: () => { rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)); return builder },
                limit: (n: number) => Promise.resolve({ data: rows.slice(0, n) }),
                maybeSingle: () => Promise.resolve({ data: rows[0] ?? null }),
              }
              return builder
            },
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (_c: string, id: string) => {
              fakeDb.updates.push({ id, payload })
              const row = fakeDb.trackingRows.find(r => r.id === id)
              if (row) Object.assign(row, payload)
              return Promise.resolve({ data: null, error: null })
            },
          }),
        }
      }
      return {
        update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null }) }) }) }),
      }
    },
  }),
}))

vi.mock("@/lib/phone-format", () => ({ normalizeGhanaPhone: (p: string) => p }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn() }))
vi.mock("@/lib/mtn-providers/agentportalgh-provider", async () => {
  const actual = await vi.importActual<any>("@/lib/mtn-providers/agentportalgh-provider")
  return {
    ...actual,
    fetchAllItemsForOrder: (id: string) => {
      if (!fakeDb.fetchAll) return Promise.resolve([])
      return fakeDb.fetchAll(id)
    },
  }
})

const REF1 = "11111111-1111-4111-8111-111111111111"
const REF2 = "22222222-2222-4222-8222-222222222222"

function seed(id: string, ref: string, phone: string, sizeGb: number) {
  const row = {
    id, mtn_order_id: ref, status: "processing", order_type: "shop", order_id: null,
    api_order_id: null, shop_order_id: null, recipient_phone: phone, size_gb: sizeGb,
    provider: "agentportalgh", created_at: new Date().toISOString(),
  }
  fakeDb.trackingRows.push(row)
  return row
}

const up = (ref: string, msisdn: string, mb = 1024) => ({ msisdn, data_mb: mb, status: "uploaded", reference: ref, created_at: "2026-11-16T10:00:00Z" })
const term = (msisdn: string, status: string, mb = 1024, reason: string | null = null, at = "2026-11-16T10:01:00Z") =>
  ({ msisdn, data_mb: mb, status, reference: null, failed_reason: reason, created_at: at })

describe("processItems — batched payloads", () => {
  beforeEach(() => {
    fakeDb.trackingRows = []
    fakeDb.updates = []
    fakeDb.fetchAll = null
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("updates each of two same-number orders by exact mtn_order_id from the batch's items", async () => {
    const a = seed("row-a", REF1, "0598842760", 1)
    const b = seed("row-b", REF2, "0241111111", 1)
    fakeDb.fetchAll = async () => [
      up(REF1, "0598842760"), up(REF2, "0241111111"),
      term("0598842760", "success"), term("0241111111", "failed", 1024, "boom"),
    ]
    // Webhook payload: terminal rows only, reference null
    await processItems({
      event: "order.completed", order_id: "agp-batch-1", success_count: 1, failure_count: 1,
      items: [term("0598842760", "success"), term("0241111111", "failed", 1024, "boom")],
    })
    expect(fakeDb.updates.find(u => u.id === a.id && u.payload.status === "completed")).toBeTruthy()
    expect(fakeDb.updates.find(u => u.id === b.id && u.payload.status === "failed")).toBeTruthy()
  })

  it("does not let a resolved number fall through to the phone+size fallback onto a different order", async () => {
    // Two orders, same phone+size; only REF1 is in this batch. REF2 (a different, later order) must stay processing.
    const a = seed("row-a", REF1, "0598842760", 1)
    const other = seed("row-other", REF2, "0598842760", 1)
    fakeDb.fetchAll = async () => [up(REF1, "0598842760"), term("0598842760", "success")]
    await processItems({
      event: "order.completed", order_id: "agp-batch-1",
      items: [term("0598842760", "success")],
    })
    expect(fakeDb.updates.some(u => u.id === a.id && u.payload.status === "completed")).toBe(true)
    expect(fakeDb.updates.some(u => u.id === other.id && u.payload.status === "completed")).toBe(false)
  })

  it("leaves ambiguous same-number references untouched", async () => {
    const a = seed("row-a", REF1, "0598842760", 1)
    const b = seed("row-b", REF2, "0598842760", 1)
    fakeDb.fetchAll = async () => [
      up(REF1, "0598842760"), up(REF2, "0598842760"),
      term("0598842760", "success"), term("0598842760", "failed", 1024, "x", "2026-11-16T10:02:00Z"),
    ]
    await processItems({
      event: "order.completed", order_id: "agp-batch-1",
      items: [term("0598842760", "success"), term("0598842760", "failed", 1024, "x", "2026-11-16T10:02:00Z")],
    })
    expect(fakeDb.updates.some(u => u.id === a.id && u.payload.status)).toBe(false)
    expect(fakeDb.updates.some(u => u.id === b.id && u.payload.status)).toBe(false)
  })

  it("keeps the old behaviour when fetching the batch items fails", async () => {
    const only = seed("row-only", REF1, "0598842760", 1)
    fakeDb.fetchAll = async () => { throw new Error("network") }
    await processItems({
      event: "order.completed", order_id: "agp-batch-1",
      items: [term("0598842760", "success")],
    })
    // old phone+size fallback: single candidate -> completed
    expect(fakeDb.updates.some(u => u.id === only.id && u.payload.status === "completed")).toBe(true)
  })

  it("leaves non-batched payloads (items carry reference) unchanged and does not fetch", async () => {
    const a = seed("row-a", REF1, "0598842760", 1)
    const spy = vi.fn(async () => [] as any[])
    fakeDb.fetchAll = spy
    await processItems({
      event: "order.completed", order_id: "agp-batch-1",
      items: [{ status: "success", msisdn: "0598842760", data_mb: 1024, reference: REF1 }],
    })
    expect(spy).not.toHaveBeenCalled()
    expect(fakeDb.updates.some(u => u.id === a.id && u.payload.status === "completed")).toBe(true)
  })
})
