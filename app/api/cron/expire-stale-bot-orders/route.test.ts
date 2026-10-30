// app/api/cron/expire-stale-bot-orders/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  client: { tag: "db" } as any,
  sweepResult: null as any,
  sweep: vi.fn(),
  watch: vi.fn(),
  notify: vi.fn(),
  order: [] as string[],
}))

vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.client }))
vi.mock("@/lib/bot-commission/stale-sweep", () => ({
  expireStaleBotOrders: async (db: any) => { h.order.push("sweep"); h.sweep(db); return h.sweepResult },
}))
vi.mock("@/lib/standard-bundles/special-watch", () => ({
  watchStuckSpecialGroups: async (db: any, deps: any) => { h.order.push("watch"); return h.watch(db, deps) },
}))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins: (...a: any[]) => h.notify(...a) }))

import { GET } from "./route"

const req = () => new NextRequest("https://x/api/cron/expire-stale-bot-orders")
const counts = { found: 1, failed: 1, payments: 0 }

beforeEach(() => {
  h.sweep.mockReset(); h.watch.mockReset(); h.notify.mockReset(); h.order = []
  h.sweepResult = { cutoff: "2026-10-30T11:30:00.000Z", tables: { hubtel_bill_orders: counts, hubtel_data_orders: counts }, errors: 0 }
  h.watch.mockResolvedValue({ skipped: false, groups: 0, alerted: 0 })
})

describe("expire-stale-bot-orders cron", () => {
  it("runs the sweep exactly as before (same client), then the read-only Special watch", async () => {
    const res = await GET(req())
    expect(h.sweep).toHaveBeenCalledWith(h.client)
    expect(h.order).toEqual(["sweep", "watch"])
    expect(h.watch.mock.calls[0][0]).toBe(h.client)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, ...h.sweepResult })
  })

  it("sweep errors still give 500 (status follows the sweep only)", async () => {
    h.sweepResult = { ...h.sweepResult, errors: 2 }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, errors: 2 })
  })

  it("a failing Special watch never changes the sweep's response", async () => {
    h.watch.mockRejectedValue(new Error("db down"))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, ...h.sweepResult })
  })

  it("the watch's alert is URGENT: notifyAdmins with email fallback kept (4th arg false)", async () => {
    await GET(req())
    const deps = h.watch.mock.calls[0][1]
    await deps.alert("Special group g: 2 paid units not sent; send them from Admin > Hubtel Commission > Standard Bundles")
    expect(h.notify).toHaveBeenCalledWith(
      "Special group g: 2 paid units not sent; send them from Admin > Hubtel Commission > Standard Bundles", "bills_review", undefined, false,
    )
  })
})
